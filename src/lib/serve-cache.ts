import fsp from "fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { games } from "@/db/schema";

/**
 * A game's asset route is hit once per file (hundreds of times when a game
 * boots), so the DB lookup is cached briefly instead of running per request.
 */
export interface ServeInfo {
  extractPath: string;
  /** realpath of extractPath, used for symlink-safe containment checks */
  rootReal: string;
  entryPoint: string | null;
}

const TTL_MS = 15_000;

const g = globalThis as typeof globalThis & {
  __gameServeCache?: Map<number, { info: ServeInfo; expires: number }>;
};
const cache = (g.__gameServeCache ??= new Map());

export function invalidateServeInfo(gameId: number): void {
  cache.delete(gameId);
}

/** Returns serving info for a READY game, or null when it is missing/not ready. */
export async function getServeInfo(gameId: number): Promise<ServeInfo | null> {
  const hit = cache.get(gameId);
  if (hit && hit.expires > Date.now()) return hit.info;

  const rows = await db
    .select({ extractPath: games.extractPath, entryPoint: games.entryPoint, status: games.status })
    .from(games)
    .where(eq(games.id, gameId))
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== "ready") return null;

  const rootReal = await fsp.realpath(row.extractPath).catch(() => null);
  if (!rootReal) return null;

  const info: ServeInfo = { extractPath: row.extractPath, rootReal, entryPoint: row.entryPoint };
  cache.set(gameId, { info, expires: Date.now() + TTL_MS });
  return info;
}
