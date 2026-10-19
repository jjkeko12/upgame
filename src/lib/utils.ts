import path from "path";
import fsp from "fs/promises";

/**
 * Root for everything this app writes to disk. Point DATA_DIR at a mounted
 * volume in production (e.g. /data in Docker).
 */
export const DATA_DIR = path.resolve(process.env.DATA_DIR || process.cwd());
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const EXTRACT_DIR = path.join(DATA_DIR, "extracts");

const GB = 1024 * 1024 * 1024;

function envBytes(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Largest single upload accepted (MAX_UPLOAD_BYTES overrides, default 10GB). */
export const MAX_UPLOAD_BYTES = envBytes("MAX_UPLOAD_BYTES", 10 * GB);
/** Largest total uncompressed size we will extract (MAX_EXTRACT_BYTES, default 20GB). */
export const MAX_EXTRACT_BYTES = envBytes("MAX_EXTRACT_BYTES", 20 * GB);

export async function ensureDirs() {
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  await fsp.mkdir(EXTRACT_DIR, { recursive: true });
}

/** True when `child` is strictly inside `parent` (never equal to it). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Removes a game's archive and extracted asset tree. Refuses to touch
 * anything outside the uploads/extracts roots, so a bad DB row can never
 * make this delete unrelated directories.
 */
export async function cleanupGameFiles(uploadPath: string, extractPath: string) {
  const uploadDir = path.dirname(uploadPath);
  if (isInside(UPLOADS_DIR, uploadDir)) {
    await fsp.rm(uploadDir, { recursive: true, force: true }).catch(() => undefined);
  } else if (isInside(UPLOADS_DIR, uploadPath)) {
    await fsp.rm(uploadPath, { force: true }).catch(() => undefined);
  }
  if (isInside(EXTRACT_DIR, extractPath)) {
    await fsp.rm(extractPath, { recursive: true, force: true }).catch(() => undefined);
  }
}
