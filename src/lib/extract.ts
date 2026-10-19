import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import zlib from "zlib";
import type { Readable } from "stream";
import yauzl from "yauzl";
import { getAssetType, findEntryPoint, isJunkPath } from "@/lib/assets";
import { MAX_EXTRACT_BYTES } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import type { AssetEntry } from "@/db/schema";

export interface ExtractResult {
  manifest: Record<string, AssetEntry>;
  totalBytes: number;
  fileCount: number;
  entryPoint: string | null;
  /** Entries that could not be extracted, with the reason. Never silently dropped. */
  skipped: { path: string; reason: string }[];
}

/** Thrown when extraction is cancelled (e.g. the game was deleted mid-way). */
export class ExtractAbortedError extends Error {
  constructor() {
    super("Extraction was cancelled");
    this.name = "ExtractAbortedError";
  }
}

/** Thrown when the archive would expand beyond the configured cap. */
export class ExtractLimitError extends Error {
  constructor(limit: number) {
    super(`The archive expands to more than ${formatBytes(limit)}, which is over the server limit.`);
    this.name = "ExtractLimitError";
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Incremental CRC-32 (native zlib.crc32 when available, JS fallback otherwise). */
const nativeCrc32 = (zlib as unknown as { crc32?: (data: Buffer, value?: number) => number }).crc32;

function crc32Update(crc: number, buf: Buffer): number {
  if (typeof nativeCrc32 === "function") return nativeCrc32(buf, crc);
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** True when a skipped entry failed only because yauzl lacks that compression method. */
export function isUnsupportedCompression(reason: string): boolean {
  return /unsupported compression method/i.test(reason);
}

/**
 * Turns low level zip errors into something a human can act on.
 */
export function friendlyExtractError(raw: string): string {
  const msg = raw.toLowerCase();

  if (msg.includes("end of central directory")) {
    return "The archive is incomplete or corrupt - the central directory is missing. The upload may not have finished, so please re-upload the file.";
  }
  if (msg.includes("invalid central directory") || msg.includes("invalid signature")) {
    return "The archive is corrupt or not a valid ZIP file.";
  }
  if (msg.includes("unsupported compression method")) {
    const m = raw.match(/compression method:\s*(\d+)/i);
    const method = m ? m[1] : "?";
    return `The archive uses compression method ${method}, which is not supported (only Store and Deflate work). Please re-create it as a standard ZIP using Deflate compression.`;
  }
  if (msg.includes("encrypted")) {
    return "The archive is password-protected, which is not supported. Please remove the password and re-upload it.";
  }
  if (msg.includes("unexpected end of file") || /\beof\b/.test(msg)) {
    return "The archive ended unexpectedly - it is most likely truncated. Please re-upload the file.";
  }
  if (msg.includes("no space left")) {
    return "The server ran out of disk space while extracting. Try removing other games first.";
  }
  return raw;
}

export interface ExtractOptions {
  /** Called as entries are processed: percent 0-99 and files extracted so far. */
  onProgress?: (percent: number, fileCount: number) => void;
  /** Hard cap on real uncompressed output, guards against zip bombs. */
  maxOutputBytes?: number;
  /** Abort to cancel extraction. */
  signal?: AbortSignal;
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // validateEntrySizes stays off for compatibility with archivers that write
    // wrong sizes; the real bytes are counted while streaming instead.
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: false },
      (err, zipfile) => {
        if (err || !zipfile) reject(err ?? new Error("Unable to open zip archive"));
        else resolve(zipfile);
      }
    );
  });
}

/**
 * Extracts a ZIP archive to disk using a streaming reader.
 * The archive is never loaded into memory, so multi-GB files are safe.
 */
export async function extractZipStream(
  zipPath: string,
  destDir: string,
  options: ExtractOptions = {}
): Promise<ExtractResult> {
  const { onProgress, maxOutputBytes = MAX_EXTRACT_BYTES, signal } = options;

  const zipfile = await openZip(zipPath);
  const destRoot = path.resolve(destDir);
  const manifest: Record<string, AssetEntry> = {};
  const skipped: { path: string; reason: string }[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  let entriesSeen = 0;
  const entryTotal = Math.max(1, zipfile.entryCount);

  const reportProgress = () => {
    onProgress?.(Math.min(99, Math.floor((entriesSeen / entryTotal) * 100)), fileCount);
  };

  const openStream = (entry: yauzl.Entry) =>
    new Promise<Readable>((resolve, reject) => {
      zipfile.openReadStream(entry, (err, stream) => {
        if (err || !stream) reject(err ?? new Error("could not read entry"));
        else resolve(stream);
      });
    });

  const skip = (relPath: string, reason: string) => {
    skipped.push({ path: relPath, reason });
  };

  /**
   * Copies one entry's stream to `target`, counting the real bytes, enforcing
   * the size cap and verifying the CRC-32. Settles as soon as anything goes
   * wrong, without waiting for stream teardown events (yauzl's streams do not
   * always emit them after a destroy, which would hang a stream.pipeline).
   */
  const pumpToFile = (stream: Readable, target: string, expectedCrc: number): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const out = fs.createWriteStream(target);
      let bytes = 0;
      let crc = 0;
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (err) {
          stream.destroy();
          out.destroy();
          reject(err);
        } else {
          resolve(bytes);
        }
      };
      const onAbort = () => finish(new ExtractAbortedError());

      if (signal?.aborted) {
        finish(new ExtractAbortedError());
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("error", (e) => finish(e));
      out.on("error", (e) => finish(e));
      // Resolve only once the file is fully flushed and closed.
      out.on("close", () => finish());

      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (totalBytes + bytes > maxOutputBytes) {
          finish(new ExtractLimitError(maxOutputBytes));
          return;
        }
        crc = crc32Update(crc, chunk);
        if (!out.write(chunk)) {
          stream.pause();
          out.once("drain", () => stream.resume());
        }
      });

      stream.on("end", () => {
        if (settled) return;
        if (crc >>> 0 !== expectedCrc >>> 0) {
          finish(new Error("CRC mismatch - the entry data is corrupt"));
          return;
        }
        out.end();
      });
    });

  /**
   * Processes one entry. Per-entry problems are recorded in `skipped` and the
   * promise still resolves; only fatal problems (cancel, size cap) reject.
   */
  const handleEntry = async (entry: yauzl.Entry): Promise<void> => {
    if (signal?.aborted) throw new ExtractAbortedError();
    entriesSeen += 1;

    const name = entry.fileName.replace(/\\/g, "/");
    if (name.endsWith("/")) return; // directory entry

    const relPath = name.replace(/^\/+/, "");
    if (!relPath || isJunkPath(relPath)) return;

    // Symlink entries are never materialised.
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) {
      skip(relPath, "symbolic links are not extracted");
      return;
    }

    // Defence in depth against path traversal (yauzl also rejects "..").
    const target = path.resolve(destRoot, relPath);
    if (!target.startsWith(destRoot + path.sep)) {
      skip(relPath, "path escapes the extraction directory");
      return;
    }

    let stream: Readable;
    try {
      stream = await openStream(entry);
    } catch (e) {
      skip(relPath, errMsg(e));
      return;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });

    let bytes: number;
    try {
      bytes = await pumpToFile(stream, target, entry.crc32);
    } catch (e) {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      if (e instanceof ExtractAbortedError || e instanceof ExtractLimitError) throw e;
      skip(relPath, errMsg(e));
      return;
    }

    // Count real bytes written, not the size the archive claims.
    const previous = manifest[relPath];
    if (previous) {
      totalBytes -= previous.size;
      fileCount -= 1;
    }
    manifest[relPath] = { path: relPath, size: bytes, type: getAssetType(relPath) };
    totalBytes += bytes;
    fileCount += 1;
  };

  return new Promise<ExtractResult>((resolve, reject) => {
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        /* already closed */
      }
      reject(err);
    };

    zipfile.on("error", fail);

    zipfile.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({
        manifest,
        totalBytes,
        fileCount,
        entryPoint: findEntryPoint(manifest),
        skipped,
      });
    });

    zipfile.on("entry", (entry: yauzl.Entry) => {
      // Exactly one readEntry() per entry, and only after it is fully handled.
      handleEntry(entry).then(() => {
        reportProgress();
        if (!settled) zipfile.readEntry();
      }, fail);
    });

    zipfile.readEntry();
  });
}

interface ExternalOptions {
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

/** Runs an external extractor (unzip / tar) and builds a manifest from the result. */
function runExternalExtractor(
  command: string,
  args: string[],
  destDir: string,
  { signal, maxOutputBytes = MAX_EXTRACT_BYTES }: ExternalOptions
): Promise<ExtractResult | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExtractAbortedError());
      return;
    }

    const proc = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    const onAbort = () => proc.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30 * 60 * 1000);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    proc.on("error", (err) => {
      cleanup();
      console.error(`[extract] system ${command} failed to start:`, err.message);
      resolve(null);
    });

    proc.on("close", async (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(new ExtractAbortedError());
        return;
      }
      if (code !== 0) {
        console.error(`[extract] system ${command} exited ${code}: ${stderr.slice(0, 500)}`);
        resolve(null);
        return;
      }
      try {
        resolve(await buildManifestFromDir(destDir, maxOutputBytes));
      } catch (e) {
        if (e instanceof ExtractLimitError) reject(e);
        else resolve(null);
      }
    });
  });
}

/**
 * Fallback extractor: uses the system `unzip` binary.
 * Handles compression methods that yauzl does not support (bzip2, lzma...).
 * The archive is still never loaded into memory by this process.
 */
export function extractZipWithSystemUnzip(
  zipPath: string,
  destDir: string,
  options: ExternalOptions = {}
): Promise<ExtractResult | null> {
  return runExternalExtractor("unzip", ["-o", "-q", zipPath, "-d", destDir], destDir, options);
}

/**
 * Fallback for tar-based archives (.tar, .tar.gz, .tgz, .tar.bz2, .tar.xz).
 */
export function extractTarWithSystemTar(
  tarPath: string,
  destDir: string,
  options: ExternalOptions = {}
): Promise<ExtractResult | null> {
  return runExternalExtractor("tar", ["-xf", tarPath, "-C", destDir, "--no-same-owner"], destDir, options);
}

/**
 * Walks an extracted directory and builds an asset manifest.
 * Symlinks (which unzip/tar may create) are deleted so nothing can point out
 * of the extraction directory, and OS junk files are removed.
 */
async function buildManifestFromDir(dir: string, maxBytes: number): Promise<ExtractResult> {
  const manifest: Record<string, AssetEntry> = {};
  const skipped: { path: string; reason: string }[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        await fsp.rm(full, { force: true });
        skipped.push({ path: rel, reason: "symbolic links are not extracted" });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (!entry.isFile()) {
        await fsp.rm(full, { force: true }).catch(() => undefined);
        continue;
      }
      if (isJunkPath(rel)) {
        await fsp.rm(full, { force: true }).catch(() => undefined);
        continue;
      }

      const stat = await fsp.lstat(full).catch(() => null);
      if (!stat) continue;

      totalBytes += stat.size;
      if (totalBytes > maxBytes) throw new ExtractLimitError(maxBytes);

      manifest[rel] = { path: rel, size: stat.size, type: getAssetType(rel) };
      fileCount += 1;
    }
  };

  await walk(dir, "");

  return {
    manifest,
    totalBytes,
    fileCount,
    entryPoint: findEntryPoint(manifest),
    skipped,
  };
}

/**
 * Handles a single (non-archive) file: copies it into the extract dir and
 * builds a one-entry manifest.
 */
export async function extractSingleFile(
  filePath: string,
  destDir: string,
  originalName: string
): Promise<ExtractResult> {
  const safeName = path.basename(originalName) || "file.bin";
  const target = path.join(destDir, safeName);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(filePath, target);
  const stat = await fsp.stat(target);
  const manifest: Record<string, AssetEntry> = {
    [safeName]: { path: safeName, size: stat.size, type: getAssetType(safeName) },
  };
  return {
    manifest,
    totalBytes: stat.size,
    fileCount: 1,
    entryPoint: findEntryPoint(manifest),
    skipped: [],
  };
}
