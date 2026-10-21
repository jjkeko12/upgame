import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { games } from "@/db/schema";
import type { Game } from "@/db/schema";
import {
  extractZipStream,
  extractSingleFile,
  extractZipWithSystemUnzip,
  extractTarWithSystemTar,
  friendlyExtractError,
  isUnsupportedCompression,
  ExtractAbortedError,
  type ExtractResult,
} from "@/lib/extract";
import { ensureEntryPoint } from "@/lib/entrypoint";
import { EXTRACT_DIR, cleanupGameFiles, ensureDirs } from "@/lib/utils";
import { activeJobs } from "@/lib/jobs";

/**
 * Creates the game record and kicks off asset extraction in the background.
 * The client polls GET /api/games/[id] for progress.
 */
export async function createGameFromArchive(opts: {
  archivePath: string;
  filename: string;
  gameName?: string;
  totalSize: number;
}): Promise<Game> {
  await ensureDirs();

  const name = (opts.gameName?.trim() || path.parse(opts.filename).name || "Untitled Game").slice(0, 255);
  const extractPath = path.join(EXTRACT_DIR, `game-${randomUUID()}`);

  const [game] = await db
    .insert(games)
    .values({
      name,
      originalFilename: opts.filename.slice(0, 255),
      uploadPath: opts.archivePath,
      extractPath,
      assetManifest: {},
      status: "extracting",
      progress: 0,
      assetCount: 0,
      totalSize: opts.totalSize,
    })
    .returning();

  // Run extraction detached so the HTTP response returns immediately. The job
  // is registered so DELETE can cancel it, and any failure is caught here so it
  // can never become an unhandled rejection.
  const controller = new AbortController();
  activeJobs.set(game.id, controller);
  void runExtraction(game.id, name, opts.archivePath, opts.filename, extractPath, controller.signal)
    .catch((err) => console.error(`[extract] game ${game.id}: unexpected failure`, err))
    .finally(() => activeJobs.delete(game.id));

  return game;
}

/** Builds a throttled, per-game progress writer. */
function makeProgressReporter(gameId: number) {
  let last = 0;
  return (percent: number, fileCount: number) => {
    const now = Date.now();
    if (now - last < 750) return;
    last = now;
    // Only while still extracting, so a late write can't overwrite "ready".
    void db
      .update(games)
      .set({ progress: percent, assetCount: fileCount, updatedAt: new Date() })
      .where(and(eq(games.id, gameId), eq(games.status, "extracting")))
      .catch(() => undefined);
  };
}

function skippedWarning(result: ExtractResult): string | null {
  if (result.skipped.length === 0) return null;
  const shown = result.skipped
    .slice(0, 5)
    .map((s) => `${s.path} (${s.reason})`)
    .join("; ");
  const more = result.skipped.length > 5 ? `; and ${result.skipped.length - 5} more` : "";
  return `${result.skipped.length} file(s) could not be extracted and are missing from this game: ${shown}${more}`;
}

async function runExtraction(
  gameId: number,
  gameName: string,
  archivePath: string,
  filename: string,
  extractPath: string,
  signal: AbortSignal
) {
  try {
    await fsp.mkdir(extractPath, { recursive: true });

    const lower = filename.toLowerCase();
    const isZip = lower.endsWith(".zip");
    const isTar = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/.test(lower);

    let result: ExtractResult;

    if (isZip) {
      result = await extractZipStream(archivePath, extractPath, {
        onProgress: makeProgressReporter(gameId),
        signal,
      });

      // If the streaming reader could not handle some entries (e.g. bzip2 or
      // lzma compression), retry with the system unzip binary, which supports
      // more methods. This also covers archives where only SOME entries failed.
      const needsFallback =
        result.fileCount === 0 || result.skipped.some((s) => isUnsupportedCompression(s.reason));
      if (needsFallback) {
        const fallback = await extractZipWithSystemUnzip(archivePath, extractPath, { signal });
        if (fallback && fallback.fileCount > 0 && fallback.fileCount >= result.fileCount) {
          result = fallback;
        }
      }

      // A ZIP that yielded nothing is almost always a problem worth reporting
      // rather than silently showing an empty game.
      if (result.fileCount === 0) {
        const firstReason = result.skipped[0]?.reason;
        throw new Error(
          firstReason
            ? friendlyExtractError(firstReason)
            : "No files could be read from the archive. It may be empty, corrupt, or truncated - please re-upload it."
        );
      }
    } else if (isTar) {
      const tarResult = await extractTarWithSystemTar(archivePath, extractPath, { signal });
      if (!tarResult || tarResult.fileCount === 0) {
        throw new Error(
          "The TAR archive could not be extracted. It may be corrupt, empty, or use an unsupported compression."
        );
      }
      result = tarResult;
    } else {
      result = await extractSingleFile(archivePath, extractPath, path.basename(filename));
    }

    // The game was deleted while we were extracting: throw the work away.
    if (signal.aborted) throw new ExtractAbortedError();

    // No HTML page? Try to generate a launcher, or work out why it can't run.
    // A failure here must never fail the whole extraction.
    let entryNote: string | null = null;
    try {
      entryNote = await ensureEntryPoint(result, extractPath, gameName);
    } catch (err) {
      console.error(`[extract] game ${gameId}: entry point analysis failed`, err);
    }

    const updated = await db
      .update(games)
      .set({
        assetManifest: result.manifest,
        assetCount: result.fileCount,
        entryPoint: result.entryPoint,
        status: "ready",
        progress: 100,
        // On success this holds notes for the user (generated launcher, why the
        // game can't run, skipped files), or null.
        extractionError: [entryNote, skippedWarning(result)].filter(Boolean).join(" ") || null,
        updatedAt: new Date(),
      })
      .where(eq(games.id, gameId))
      .returning({ id: games.id });

    if (updated.length === 0) {
      // Row vanished (deleted) between the abort check and now.
      await cleanupGameFiles(archivePath, extractPath);
      return;
    }

    console.log(
      `[extract] game ${gameId}: ${result.fileCount} files, ${(result.totalBytes / 1024 / 1024).toFixed(1)}MB extracted` +
        (result.skipped.length ? `, ${result.skipped.length} skipped` : "")
    );
  } catch (error) {
    // Cancelled because the game was deleted: DELETE already removed the row.
    if (error instanceof ExtractAbortedError || signal.aborted) {
      await cleanupGameFiles(archivePath, extractPath);
      return;
    }

    console.error(`[extract] game ${gameId} failed:`, error);
    // Free the disk space taken by a partial extraction.
    await fsp.rm(extractPath, { recursive: true, force: true }).catch(() => undefined);

    const raw = error instanceof Error ? error.message : "Extraction failed";
    try {
      await db
        .update(games)
        .set({
          status: "error",
          extractionError: friendlyExtractError(raw),
          updatedAt: new Date(),
        })
        .where(eq(games.id, gameId));
    } catch (dbError) {
      console.error(`[extract] game ${gameId}: could not record failure`, dbError);
    }
  }
}
