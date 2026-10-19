import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { appendChunk, discardUpload, isComplete, isValidUploadId, UploadError } from "@/lib/chunks";
import { CHUNK_SIZE } from "@/lib/constants";
import { MAX_UPLOAD_BYTES } from "@/lib/utils";
import { guardMutation } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Decodes a header value without throwing on malformed percent-encoding. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Receives a single raw binary chunk of a large upload.
 * Headers:
 *   x-upload-id     - UUID for the upload session
 *   x-chunk-index   - zero based chunk index
 *   x-total-chunks  - number of chunks in the file
 *   x-filename      - original file name (URI encoded)
 *   x-file-size     - total file size in bytes
 *   x-game-name     - optional display name (URI encoded)
 */
export async function POST(request: NextRequest) {
  const denied = guardMutation(request);
  if (denied) return denied;

  try {
    const uploadId = request.headers.get("x-upload-id");
    if (!isValidUploadId(uploadId)) {
      return NextResponse.json({ error: "Missing or invalid x-upload-id" }, { status: 400 });
    }

    const chunkIndex = Number(request.headers.get("x-chunk-index"));
    const totalChunks = Number(request.headers.get("x-total-chunks"));
    const fileSize = Number(request.headers.get("x-file-size"));

    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      return NextResponse.json({ error: "Missing or invalid x-file-size" }, { status: 400 });
    }
    if (fileSize > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File is larger than the server limit of ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024)}GB` },
        { status: 413 }
      );
    }

    // Reject oversized bodies before buffering them.
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > CHUNK_SIZE) {
      return NextResponse.json({ error: "Chunk exceeds maximum size" }, { status: 413 });
    }

    const buffer = Buffer.from(await request.arrayBuffer());

    const rawName = request.headers.get("x-filename");
    const filename = rawName ? path.basename(safeDecode(rawName)).slice(0, 255) : "";
    const gameName = (request.headers.get("x-game-name") ? safeDecode(request.headers.get("x-game-name")!) : "").slice(0, 255);

    const meta = await appendChunk(
      uploadId,
      { chunkIndex, totalChunks, totalSize: fileSize, filename, gameName },
      buffer
    );

    return NextResponse.json({
      ok: true,
      uploadId,
      received: meta.receivedChunks.length,
      total: meta.totalChunks,
      receivedBytes: meta.receivedBytes,
      complete: isComplete(meta),
    });
  } catch (error) {
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error receiving chunk:", error);
    return NextResponse.json({ error: "Failed to receive chunk" }, { status: 500 });
  }
}

/** Cancels an upload and deletes whatever part of it was received. */
export async function DELETE(request: NextRequest) {
  const denied = guardMutation(request);
  if (denied) return denied;

  const uploadId = request.nextUrl.searchParams.get("uploadId");
  if (!isValidUploadId(uploadId)) {
    return NextResponse.json({ error: "Missing or invalid uploadId" }, { status: 400 });
  }
  try {
    await discardUpload(uploadId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error discarding upload:", error);
    return NextResponse.json({ error: "Failed to discard upload" }, { status: 500 });
  }
}
