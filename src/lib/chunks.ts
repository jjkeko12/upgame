import fsp from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { UPLOADS_DIR } from "@/lib/utils";
import { CHUNK_SIZE, UPLOAD_ID_RE } from "@/lib/constants";

export { CHUNK_SIZE };

export const TMP_DIR = path.join(UPLOADS_DIR, "tmp");

export interface UploadMeta {
  uploadId: string;
  filename: string;
  gameName: string;
  /** Declared size of the complete file in bytes. */
  totalSize: number;
  totalChunks: number;
  receivedChunks: number[];
  /** Byte length of each received chunk, keyed by chunk index. */
  chunkSizes: Record<string, number>;
  receivedBytes: number;
  createdAt: number;
  updatedAt: number;
}

/** An error that carries the HTTP status the route should answer with. */
export class UploadError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

export function isValidUploadId(id: unknown): id is string {
  return typeof id === "string" && UPLOAD_ID_RE.test(id);
}

/** Upload ids become file names, so they are validated before every use. */
function assertUploadId(id: string): void {
  if (!isValidUploadId(id)) throw new UploadError("Invalid upload id", 400);
}

export async function ensureTmpDir() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

const partPath = (id: string) => path.join(TMP_DIR, `${id}.part`);
const metaPath = (id: string) => path.join(TMP_DIR, `${id}.meta.json`);

// ---------------------------------------------------------------------------
// Per-upload lock. Serialises every read-modify-write of one upload's state.
// NOTE: in-process only. Run a single server instance (see README).
// ---------------------------------------------------------------------------
const locks = new Map<string, Promise<unknown>>();

export function withUploadLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(uploadId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(uploadId, tail);
  void tail.then(() => {
    if (locks.get(uploadId) === tail) locks.delete(uploadId);
  });
  return run;
}

export async function readMeta(uploadId: string): Promise<UploadMeta | null> {
  assertUploadId(uploadId);
  try {
    const raw = await fsp.readFile(metaPath(uploadId), "utf8");
    return JSON.parse(raw) as UploadMeta;
  } catch {
    return null;
  }
}

/** Writes via temp file + rename so readers never see a half-written file. */
async function writeMeta(meta: UploadMeta): Promise<void> {
  const target = metaPath(meta.uploadId);
  const tmp = `${target}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(meta));
  await fsp.rename(tmp, target);
}

export interface ChunkInfo {
  chunkIndex: number;
  totalChunks: number;
  totalSize: number;
  filename: string;
  gameName: string;
}

/** Expected byte length of chunk `index` for a file of `totalSize` bytes. */
export function expectedChunkLength(index: number, totalSize: number): number {
  return Math.min(CHUNK_SIZE, totalSize - index * CHUNK_SIZE);
}

/**
 * Validates and stores one chunk, then records it in the upload's metadata.
 * Everything happens inside the upload lock, so concurrent chunk requests can
 * never overwrite each other's bookkeeping.
 */
export function appendChunk(uploadId: string, info: ChunkInfo, chunk: Buffer): Promise<UploadMeta> {
  assertUploadId(uploadId);
  return withUploadLock(uploadId, async () => {
    const { chunkIndex, totalChunks, totalSize } = info;

    if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
      throw new UploadError("Invalid or empty file size", 400);
    }
    if (totalChunks !== Math.ceil(totalSize / CHUNK_SIZE)) {
      throw new UploadError("Chunk count does not match file size", 400);
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
      throw new UploadError("Invalid chunk index", 400);
    }
    const expected = expectedChunkLength(chunkIndex, totalSize);
    if (chunk.length !== expected) {
      throw new UploadError(
        `Chunk ${chunkIndex} has ${chunk.length} bytes but ${expected} were expected`,
        400
      );
    }

    await ensureTmpDir();

    const now = Date.now();
    const existing = await readMeta(uploadId);
    if (existing && (existing.totalSize !== totalSize || existing.totalChunks !== totalChunks)) {
      throw new UploadError("Upload parameters changed mid-upload", 409);
    }

    const fh = await fsp.open(partPath(uploadId), fsConstants.O_RDWR | fsConstants.O_CREAT, 0o600);
    try {
      const offset = chunkIndex * CHUNK_SIZE;
      let written = 0;
      while (written < chunk.length) {
        const { bytesWritten } = await fh.write(chunk, written, chunk.length - written, offset + written);
        if (bytesWritten === 0) throw new Error("Disk write returned 0 bytes");
        written += bytesWritten;
      }
    } finally {
      await fh.close();
    }

    const meta: UploadMeta = existing ?? {
      uploadId,
      filename: info.filename,
      gameName: info.gameName,
      totalSize,
      totalChunks,
      receivedChunks: [],
      chunkSizes: {},
      receivedBytes: 0,
      createdAt: now,
      updatedAt: now,
    };

    if (!meta.receivedChunks.includes(chunkIndex)) {
      meta.receivedChunks.push(chunkIndex);
      meta.receivedChunks.sort((a, b) => a - b);
    }
    meta.chunkSizes[String(chunkIndex)] = chunk.length;
    meta.receivedBytes = Object.values(meta.chunkSizes).reduce((sum, n) => sum + n, 0);
    meta.filename = info.filename || meta.filename;
    meta.gameName = info.gameName || meta.gameName;
    meta.updatedAt = now;

    await writeMeta(meta);
    return meta;
  });
}

export function isComplete(meta: UploadMeta): boolean {
  if (meta.receivedChunks.length !== meta.totalChunks) return false;
  for (let i = 0; i < meta.totalChunks; i++) {
    if (!meta.receivedChunks.includes(i)) return false;
  }
  return true;
}

/**
 * Verifies the assembled file against what was declared and moves it to
 * `destPath`. MUST be called inside withUploadLock for this upload.
 */
export async function finalizePartFile(uploadId: string, destPath: string): Promise<UploadMeta> {
  assertUploadId(uploadId);
  const meta = await readMeta(uploadId);
  if (!meta) {
    throw new UploadError(
      "Upload session not found - no data was received. The connection likely dropped on the first chunk, so please try again.",
      404
    );
  }
  if (!isComplete(meta)) {
    throw new UploadError(
      `Upload incomplete: ${meta.receivedChunks.length}/${meta.totalChunks} chunks received. Please retry the upload.`,
      400
    );
  }

  const stat = await fsp.stat(partPath(uploadId)).catch(() => null);
  if (!stat || stat.size !== meta.totalSize) {
    await discardUploadFiles(uploadId);
    throw new UploadError(
      `Upload corrupted: assembled file is ${stat?.size ?? 0} bytes but ${meta.totalSize} were expected. Please try again.`,
      400
    );
  }

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.rename(partPath(uploadId), destPath);
  await fsp.rm(metaPath(uploadId), { force: true });
  return meta;
}

async function discardUploadFiles(uploadId: string): Promise<void> {
  await fsp.rm(partPath(uploadId), { force: true }).catch(() => undefined);
  await fsp.rm(metaPath(uploadId), { force: true }).catch(() => undefined);
}

/** Deletes a partial upload (used when the user cancels). */
export function discardUpload(uploadId: string): Promise<void> {
  assertUploadId(uploadId);
  return withUploadLock(uploadId, () => discardUploadFiles(uploadId));
}

/** Removes abandoned part/meta files that have not been touched for `maxAgeMs`. */
export async function cleanupStaleUploads(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fsp.readdir(TMP_DIR);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    const full = path.join(TMP_DIR, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fsp.rm(full, { force: true });
        removed += 1;
      }
    } catch {
      /* file vanished - fine */
    }
  }
  return removed;
}
