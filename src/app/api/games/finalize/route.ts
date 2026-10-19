import path from "path";
import fsp from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { finalizePartFile, isValidUploadId, readMeta, UploadError, withUploadLock } from "@/lib/chunks";
import { createGameFromArchive } from "@/lib/process";
import { UPLOADS_DIR, ensureDirs } from "@/lib/utils";
import { guardMutation } from "@/lib/security";
import type { Game } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Remembers finished uploads for a while so a retried/double-clicked finalize
// returns the same game instead of a confusing 404.
const g = globalThis as typeof globalThis & {
  __gameFinalized?: Map<string, { game: Game; expires: number }>;
};
const finalized = (g.__gameFinalized ??= new Map());

/**
 * Called after all chunks of an upload have been received.
 * Verifies the assembled file, moves it into place and starts extraction.
 */
export async function POST(request: NextRequest) {
  const denied = guardMutation(request);
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => ({}));
    const uploadId: unknown = body?.uploadId;

    if (!isValidUploadId(uploadId)) {
      return NextResponse.json({ error: "A valid uploadId is required" }, { status: 400 });
    }

    const { game, created } = await withUploadLock(uploadId, async () => {
      for (const [key, value] of finalized) {
        if (value.expires < Date.now()) finalized.delete(key);
      }
      const done = finalized.get(uploadId);
      if (done) return { game: done.game, created: false };

      await ensureDirs();

      const meta = await readMeta(uploadId);
      const rawName: string = (typeof body?.filename === "string" && body.filename) || meta?.filename || "upload.bin";
      const filename = path.basename(rawName).slice(0, 255) || "upload.bin";
      const gameName: string | undefined =
        (typeof body?.gameName === "string" && body.gameName) || meta?.gameName || undefined;

      const ext = path.extname(filename).toLowerCase();
      const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ".bin";
      const destDir = path.join(UPLOADS_DIR, `up-${uploadId}`);
      const destPath = path.join(destDir, `original${safeExt}`);

      // Verifies completeness and size, then moves the file into place.
      const finished = await finalizePartFile(uploadId, destPath);

      try {
        const row = await createGameFromArchive({
          archivePath: destPath,
          filename,
          gameName,
          totalSize: finished.totalSize,
        });
        finalized.set(uploadId, { game: row, expires: Date.now() + 10 * 60 * 1000 });
        return { game: row, created: true };
      } catch (err) {
        // Don't leave an orphaned archive behind if the DB insert failed.
        await fsp.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
    });

    return NextResponse.json(game, { status: created ? 201 : 200 });
  } catch (error) {
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error finalizing upload:", error);
    return NextResponse.json({ error: "Failed to finalize upload" }, { status: 500 });
  }
}
