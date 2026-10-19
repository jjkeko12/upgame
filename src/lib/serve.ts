import fsp from "fs/promises";
import type { Stats } from "fs";
import path from "path";
import { isInside } from "@/lib/utils";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".glsl": "text/plain; charset=utf-8",
  ".frag": "text/plain; charset=utf-8",
  ".vert": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mid": "audio/midi",
  ".midi": "audio/midi",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  // generic binary game data (Unity/Godot/Emscripten builds)
  ".data": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".pck": "application/octet-stream",
  ".unityweb": "application/octet-stream",
  ".jsdata": "application/octet-stream",
};

export interface ContentInfo {
  type: string;
  /** Set for pre-compressed assets such as game.wasm.gz (Unity WebGL builds). */
  encoding?: "gzip" | "br";
}

/** Picks a Content-Type, and a Content-Encoding for known pre-compressed files. */
export function contentInfoFor(file: string): ContentInfo {
  const lower = file.toLowerCase();
  const ext = path.extname(lower);
  if (ext === ".gz" || ext === ".br") {
    const inner = path.extname(lower.slice(0, -ext.length));
    const innerType = MIME[inner];
    if (innerType) return { type: innerType, encoding: ext === ".gz" ? "gzip" : "br" };
  }
  return { type: MIME[ext] ?? "application/octet-stream" };
}

export function isHtmlFile(file: string): boolean {
  return /\.html?$/i.test(file);
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range: bytes=...` header.
 * Returns null when the header should be ignored (serve the full file with 200),
 * or "invalid" when the response must be 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | "invalid" | null {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // malformed or multi-range: ignore
  const [, a, b] = m;
  if (a === "" && b === "") return null;

  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** Decodes HTML bytes honouring a declared non-UTF-8 charset, so we can re-serve it as UTF-8. */
export function decodeHtml(buf: Buffer): string {
  const head = buf.subarray(0, 2048).toString("latin1");
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-:.]+)/i.exec(head);
  const label = m?.[1];
  if (label && !/^utf-?8$/i.test(label)) {
    try {
      return new TextDecoder(label).decode(buf);
    } catch {
      /* unknown label: fall through to UTF-8 */
    }
  }
  return buf.toString("utf8");
}

const encodePath = (posixPath: string) =>
  posixPath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

/**
 * Makes an uploaded HTML page work when served under /api/games/:id/raw/...:
 *  - adds <base> so relative URLs resolve next to the page (unless it has one)
 *  - rewrites root-relative src/href/poster/action ("/assets/x.js") to the game's
 *    own root. Root-relative URLs built inside JavaScript cannot be fixed this way.
 */
export function injectIntoHtml(
  html: string,
  opts: { gameId: number; fileDir: string; siteRootDir: string }
): string {
  const rawPrefix = `/api/games/${opts.gameId}/raw/`;
  const dirPart = (d: string) => (d && d !== "." ? `${encodePath(d)}/` : "");
  const baseHref = rawPrefix + dirPart(opts.fileDir);
  const rootPrefix = rawPrefix + dirPart(opts.siteRootDir);

  const rewritten = html.replace(
    /(\b(?:src|href|poster|action|data-src)\s*=\s*)(["'])\/(?!\/|api\/games\/)/gi,
    (_m, attr: string, quote: string) => `${attr}${quote}${rootPrefix}`
  );

  if (/<base[\s>]/i.test(rewritten)) return rewritten;

  const tag = `<base href="${baseHref}">`;
  if (/<head(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<head(?:\s[^>]*)?>/i, (m) => m + tag);
  }
  if (/<html(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<html(?:\s[^>]*)?>/i, (m) => `${m}<head>${tag}</head>`);
  }
  return tag + rewritten;
}

export interface ResolvedFile {
  /** Absolute real path on disk */
  real: string;
  /** Path relative to the game root, using "/" separators */
  rel: string;
  stat: Stats;
}

/**
 * Maps request path segments to a real file inside `rootReal`.
 * Uses realpath so symlinks cannot point outside, tries both the segments as
 * given and URL-decoded (frameworks differ on whether params arrive decoded),
 * and serves index.html for directories.
 */
export async function resolveServedFile(rootReal: string, segments: string[]): Promise<ResolvedFile | null> {
  const decoded = segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const variants =
    JSON.stringify(decoded) === JSON.stringify(segments) ? [segments] : [segments, decoded];

  for (const variant of variants) {
    if (variant.some((s) => s.includes("\0"))) continue;
    const candidate = path.resolve(rootReal, ...variant);
    if (candidate !== rootReal && !isInside(rootReal, candidate)) continue;

    let real = await fsp.realpath(candidate).catch(() => null);
    if (!real) continue;
    let stat = await fsp.stat(real).catch(() => null);
    if (stat?.isDirectory()) {
      real = await fsp.realpath(path.join(real, "index.html")).catch(() => null);
      if (!real) continue;
      stat = await fsp.stat(real).catch(() => null);
    }
    if (!stat?.isFile()) continue;
    if (!isInside(rootReal, real)) continue;

    return { real, rel: path.relative(rootReal, real).split(path.sep).join("/"), stat };
  }
  return null;
}
