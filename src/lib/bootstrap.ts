import fsp from "fs/promises";
import { eq, inArray } from "drizzle-orm";
import { db, getPool } from "@/db";
import { games } from "@/db/schema";
import { cleanupStaleUploads } from "@/lib/chunks";
import { activeJobs } from "@/lib/jobs";
import { ensureDirs, isInside, EXTRACT_DIR } from "@/lib/utils";

/**
 * Creates the games table when it does not exist, so a fresh database (Docker,
 * a new Postgres) works without a manual migration step. For schema changes
 * during development you can still run `npm run db:push`.
 */
export async function ensureSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS games (
      id serial PRIMARY KEY,
      name varchar(255) NOT NULL,
      original_filename varchar(255) NOT NULL,
      upload_path text NOT NULL,
      extract_path text NOT NULL,
      asset_manifest jsonb,
      status varchar(50) NOT NULL DEFAULT 'uploading',
      progress integer NOT NULL DEFAULT 0,
      asset_count integer NOT NULL DEFAULT 0,
      total_size bigint NOT NULL DEFAULT 0,
      extraction_error text,
      entry_point text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Extraction runs inside this process, so a restart kills it mid-way. Mark
 * those games as failed instead of leaving them "extracting" forever.
 */
export async function recoverInterruptedGames(): Promise<number> {
  const stuck = await db
    .select({ id: games.id, extractPath: games.extractPath })
    .from(games)
    .where(inArray(games.status, ["extracting", "uploading"]));

  let recovered = 0;
  for (const game of stuck) {
    if (activeJobs.has(game.id)) continue;
    if (isInside(EXTRACT_DIR, game.extractPath)) {
      await fsp.rm(game.extractPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await db
      .update(games)
      .set({
        status: "error",
        extractionError:
          "Extraction was interrupted by a server restart. Please delete this game and upload it again.",
        updatedAt: new Date(),
      })
      .where(eq(games.id, game.id));
    recovered += 1;
  }
  return recovered;
}

const g = globalThis as typeof globalThis & { __gameBootstrapped?: boolean };

/** Runs once per server process (called from instrumentation.ts). */
export async function bootstrap(): Promise<void> {
  if (g.__gameBootstrapped) return;
  g.__gameBootstrapped = true;

  await ensureDirs();

  try {
    await ensureSchema();
    const recovered = await recoverInterruptedGames();
    if (recovered > 0) console.log(`[bootstrap] marked ${recovered} interrupted game(s) as failed`);
  } catch (err) {
    console.error("[bootstrap] database setup failed (is DATABASE_URL correct?):", err);
  }

  // Abandoned partial uploads (e.g. the browser tab was closed) are removed
  // after 24h of inactivity, checked hourly.
  const sweep = () =>
    cleanupStaleUploads()
      .then((n) => n > 0 && console.log(`[bootstrap] removed ${n} stale upload file(s)`))
      .catch(() => undefined);
  void sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}
