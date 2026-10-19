import { CHUNK_SIZE } from "@/lib/constants";

export { CHUNK_SIZE };

const CONCURRENCY = 3;
/** A chunk is aborted and retried when NO bytes move for this long. */
const STALL_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;

export interface UploadCallbacks {
  /** Overall upload progress 0-100 (byte accurate, includes in-flight bytes). */
  onProgress?: (percent: number, uploadedBytes: number, totalBytes: number) => void;
  /** Called once the server has accepted the upload and started extraction. */
  onComplete?: (gameId: number) => void;
  /** Called once with the final error message when the upload fails (not on cancel). */
  onError?: (message: string) => void;
  /** Fired when a chunk fails and is being retried. */
  onRetry?: (chunkIndex: number, totalChunks: number, attempt: number, max: number) => void;
  /** Fired when a chunk starts uploading. */
  onChunkStart?: (chunkIndex: number, totalChunks: number) => void;
  signal?: AbortSignal;
}

const abortError = () => new DOMException("Aborted", "AbortError");
const isAbortError = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

function newUploadId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (plain http on a LAN): RFC 4122 v4 from getRandomValues/Math.random
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Sleeps, but wakes up (and rejects) immediately when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type AttemptResult = { ok: true } | { ok: false; error: string; retryable: boolean };

/**
 * One XHR attempt for one chunk. Always settles: success/failure resolves,
 * a user cancel rejects with AbortError. A stall (no progress for
 * STALL_TIMEOUT_MS) resolves as a retryable failure.
 */
function sendChunkOnce(
  url: string,
  headers: Record<string, string>,
  blob: Blob,
  onLoaded: (loaded: number) => void,
  signal?: AbortSignal
): Promise<AttemptResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const xhr = new XMLHttpRequest();
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Settles exactly once. Every path below goes through here, so nothing
    // can be left hanging (the old code swallowed its own abort/timeout events).
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const armStallTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        settle(() => resolve({ ok: false, error: "Upload stalled (no data sent for 60s)", retryable: true }));
        xhr.abort();
      }, STALL_TIMEOUT_MS);
    };

    const onAbort = () => {
      settle(() => reject(abortError()));
      xhr.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    xhr.open("POST", url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      armStallTimer(); // bytes are moving, so this is not a stall
      if (e.lengthComputable) onLoaded(e.loaded);
    };

    xhr.onload = () =>
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onLoaded(blob.size);
          resolve({ ok: true });
          return;
        }
        let msg = `Server rejected the chunk (HTTP ${xhr.status})`;
        try {
          const parsed = JSON.parse(xhr.responseText);
          if (parsed?.error) msg = parsed.error;
        } catch {
          /* not JSON */
        }
        // 4xx (except timeouts / rate limits) will fail identically every time.
        const retryable = xhr.status >= 500 || xhr.status === 408 || xhr.status === 429;
        resolve({ ok: false, error: msg, retryable });
      });

    xhr.onerror = () =>
      settle(() => resolve({ ok: false, error: "Network error while uploading", retryable: true }));

    // Only reached for aborts we did not initiate; our own paths settled already.
    xhr.onabort = () =>
      settle(() => resolve({ ok: false, error: "Transfer was aborted", retryable: true }));

    armStallTimer();
    xhr.send(blob);
  });
}

/** Sends one chunk with retries and exponential backoff. */
async function sendChunkWithRetry(
  headers: Record<string, string>,
  index: number,
  totalChunks: number,
  blob: Blob,
  onLoaded: (loaded: number) => void,
  onRetry: (chunkIndex: number, totalChunks: number, attempt: number, max: number) => void,
  signal?: AbortSignal
): Promise<void> {
  let lastError = "Upload failed";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      onRetry(index, totalChunks, attempt, MAX_RETRIES);
      await sleep(400 * Math.pow(2, attempt - 2), signal);
      onLoaded(0);
    }

    const result = await sendChunkOnce("/api/games/upload", headers, blob, onLoaded, signal);
    if (result.ok) return;

    lastError = result.error;
    if (!result.retryable) break;
  }

  throw new Error(`Chunk ${index + 1} of ${totalChunks} failed: ${lastError}`);
}

/** Best-effort: tell the server to delete a cancelled upload's partial data. */
function discardOnServer(uploadId: string) {
  try {
    void fetch(`/api/games/upload?uploadId=${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/**
 * Uploads a large file in resilient chunks, then finalizes it on the server.
 * Rejects with an AbortError (DOMException) when cancelled via `signal`.
 */
export async function uploadFileChunked(
  file: File,
  gameName: string,
  callbacks: UploadCallbacks = {}
): Promise<number> {
  const { onProgress, onComplete, onError, onRetry, onChunkStart, signal } = callbacks;

  if (file.size === 0) {
    const msg = "The selected file is empty.";
    onError?.(msg);
    throw new Error(msg);
  }

  const uploadId = newUploadId();
  const totalBytes = file.size;
  const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);

  const chunkSizeOf = (i: number) => Math.min(CHUNK_SIZE, Math.max(0, totalBytes - i * CHUNK_SIZE));

  // One controller for the whole upload: aborts when the user cancels OR when
  // any chunk fails permanently, so no worker keeps sending after a failure.
  const internal = new AbortController();
  const onUserAbort = () => internal.abort();
  if (signal?.aborted) internal.abort();
  else signal?.addEventListener("abort", onUserAbort, { once: true });

  const completed = new Set<number>();
  const inFlight = new Map<number, number>();

  const report = () => {
    let bytes = 0;
    for (const i of completed) bytes += chunkSizeOf(i);
    for (const [i, loaded] of inFlight) bytes += Math.min(loaded, chunkSizeOf(i));
    const percent = Math.min(100, (bytes / totalBytes) * 100);
    onProgress?.(percent, bytes, totalBytes);
  };

  const baseHeaders: Record<string, string> = {
    "x-upload-id": uploadId,
    "x-total-chunks": String(totalChunks),
    "x-filename": encodeURIComponent(file.name),
    "x-file-size": String(totalBytes),
  };
  if (gameName) baseHeaders["x-game-name"] = encodeURIComponent(gameName);

  let nextIndex = 0;
  let firstError: Error | null = null;

  const worker = async () => {
    while (nextIndex < totalChunks && !internal.signal.aborted) {
      const index = nextIndex++;
      const start = index * CHUNK_SIZE;
      const blob = file.slice(start, Math.min(start + CHUNK_SIZE, totalBytes));

      onChunkStart?.(index, totalChunks);
      inFlight.set(index, 0);
      try {
        await sendChunkWithRetry(
          { ...baseHeaders, "x-chunk-index": String(index) },
          index,
          totalChunks,
          blob,
          (loaded) => {
            inFlight.set(index, loaded);
            report();
          },
          onRetry ?? (() => undefined),
          internal.signal
        );
        inFlight.delete(index);
        completed.add(index);
        report();
      } catch (err) {
        inFlight.delete(index);
        if (!isAbortError(err) && !firstError) {
          firstError = err instanceof Error ? err : new Error("Upload failed");
          internal.abort(); // stop the other workers
        }
        throw err;
      }
    }
  };

  try {
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, totalChunks) }, () => worker())
    );

    if (signal?.aborted) throw abortError();
    if (firstError) throw firstError;
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (rejected) throw rejected.reason;

    report();

    // Ask the server to verify + assemble + extract
    const res = await fetch("/api/games/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId, filename: file.name, gameName }),
      signal,
    });

    if (!res.ok) {
      let msg = "Failed to finalize upload";
      try {
        const parsed = await res.json();
        if (parsed?.error) msg = parsed.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }

    const game = await res.json();
    onComplete?.(game.id);
    return game.id;
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      discardOnServer(uploadId);
      throw abortError();
    }
    const message = err instanceof Error ? err.message : "Upload failed";
    onError?.(message);
    throw err instanceof Error ? err : new Error(message);
  } finally {
    signal?.removeEventListener("abort", onUserAbort);
  }
}
