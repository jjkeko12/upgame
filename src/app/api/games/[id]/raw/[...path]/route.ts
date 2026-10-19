import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { NextRequest } from "next/server";
import { getServeInfo } from "@/lib/serve-cache";
import {
  contentInfoFor,
  decodeHtml,
  injectIntoHtml,
  isHtmlFile,
  parseRange,
  resolveServedFile,
} from "@/lib/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** HTML larger than this is streamed untouched instead of being buffered for rewriting. */
const MAX_REWRITE_BYTES = 32 * 1024 * 1024;

// Game assets are public, GET-only static files. CORS is open so games running
// in a sandboxed (opaque-origin) iframe can still fetch their own files.
const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

/**
 * Uploaded HTML is untrusted. A CSP `sandbox` header makes the browser treat the
 * document as a unique opaque origin even when it is opened directly (the
 * "Open" button) instead of inside the sandboxed iframe, so game code can never
 * call this app's API. Same-origin access is granted only when the player asks
 * for it (?trusted=1) or the request arrives on the dedicated game origin.
 */
const SANDBOX_FLAGS =
  "allow-scripts allow-pointer-lock allow-popups allow-forms allow-modals allow-downloads allow-orientation-lock allow-presentation";

function htmlSecurityHeaders(request: NextRequest): Record<string, string> {
  let sameOrigin = request.nextUrl.searchParams.get("trusted") === "1";
  const gameOrigin = process.env.NEXT_PUBLIC_GAME_ORIGIN;
  if (gameOrigin) {
    try {
      const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
      sameOrigin = new URL(gameOrigin).host === (forwarded || request.headers.get("host"));
    } catch {
      /* invalid env value: keep the default */
    }
  }
  return {
    "Content-Security-Policy": `sandbox ${SANDBOX_FLAGS}${sameOrigin ? " allow-same-origin" : ""}`,
  };
}

const notFound = () =>
  new Response("Not found", { status: 404, headers: { ...BASE_HEADERS, "Cache-Control": "no-store" } });

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE_HEADERS,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, If-None-Match",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const { id, path: segments } = await params;
    if (!/^\d+$/.test(id)) return notFound();
    const gameId = Number(id);

    const info = await getServeInfo(gameId);
    if (!info) return notFound();

    const requested =
      segments && segments.length > 0
        ? segments
        : (info.entryPoint ?? "index.html").split("/");

    const file = await resolveServedFile(info.rootReal, requested);
    if (!file) return notFound();

    const content = contentInfoFor(file.rel);

    // ---- HTML: rewrite so relative and root-relative URLs resolve under the raw route
    if (isHtmlFile(file.rel) && file.stat.size <= MAX_REWRITE_BYTES) {
      const html = decodeHtml(await fsp.readFile(file.real));
      const out = Buffer.from(
        injectIntoHtml(html, {
          gameId,
          fileDir: path.posix.dirname(file.rel),
          siteRootDir: info.entryPoint ? path.posix.dirname(info.entryPoint) : ".",
        }),
        "utf8"
      );
      return new Response(new Uint8Array(out), {
        status: 200,
        headers: {
          ...BASE_HEADERS,
          ...htmlSecurityHeaders(request),
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(out.length),
          "Cache-Control": "no-store",
        },
      });
    }

    // ---- Everything else: stream from disk with Range + conditional request support
    const size = file.stat.size;
    const etag = `W/"${size.toString(16)}-${Math.floor(file.stat.mtimeMs).toString(16)}"`;
    const headers = new Headers({
      ...BASE_HEADERS,
      "Content-Type": content.type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
      ETag: etag,
      "Last-Modified": file.stat.mtime.toUTCString(),
    });
    if (content.encoding) headers.set("Content-Encoding", content.encoding);
    if (isHtmlFile(file.rel)) {
      for (const [k, v] of Object.entries(htmlSecurityHeaders(request))) headers.set(k, v);
    }

    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }

    const range = parseRange(request.headers.get("range"), size);
    if (range === "invalid") {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    headers.set("Content-Length", String(size === 0 ? 0 : end - start + 1));
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

    if (size === 0) return new Response(null, { status: 200, headers });

    const nodeStream = fs.createReadStream(file.real, { start, end });
    const body = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    console.error("Error serving game asset:", error);
    return new Response("Failed to serve file", {
      status: 500,
      headers: { ...BASE_HEADERS, "Cache-Control": "no-store" },
    });
  }
}
