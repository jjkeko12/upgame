"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { uploadFileChunked, CHUNK_SIZE } from "@/lib/upload-client";
import { formatBytes } from "@/lib/format";

type Stage = "idle" | "uploading" | "extracting" | "done" | "error";

interface Phase {
  label: string;
  detail: string;
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [gameName, setGameName] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [percent, setPercent] = useState(0);
  const [phase, setPhase] = useState<Phase>({ label: "", detail: "" });
  const [error, setError] = useState<string | null>(null);
  const [retryInfo, setRetryInfo] = useState<string | null>(null);
  const [currentChunk, setCurrentChunk] = useState<{ index: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const router = useRouter();

  // Stops polling / redirects if the user navigates away mid-extraction.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setFile(null);
    setGameName("");
    setStage("idle");
    setPercent(0);
    setPhase({ label: "", detail: "" });
    setError(null);
    setRetryInfo(null);
    setCurrentChunk(null);
  }, []);

  /** Polls the game record until extraction finishes. */
  const pollUntilReady = useCallback(
    async (id: number): Promise<{ ok: boolean; warning: string | null }> => {
      for (let i = 0; i < 1800; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!aliveRef.current) return { ok: false, warning: null };
        try {
          const res = await fetch(`/api/games/${id}`, { cache: "no-store" });
          if (res.status === 404) {
            setStage("error");
            setError("This game no longer exists (it may have been deleted).");
            return { ok: false, warning: null };
          }
          if (!res.ok) continue;
          const g = await res.json();

          if (g.status === "ready") {
            const warning: string | null = g.extractionError || null;
            setPercent(100);
            setPhase({
              label: warning ? "Ready (with warnings)" : "Ready",
              detail: warning ?? `${g.assetCount ?? 0} assets extracted`,
            });
            setStage("done");
            return { ok: true, warning };
          }

          if (g.status === "error") {
            setStage("error");
            setError(g.extractionError || "Extraction failed");
            return { ok: false, warning: null };
          }

          setPercent(typeof g.progress === "number" ? g.progress : 0);
          setPhase({
            label: "Extracting assets",
            detail: g.assetCount
              ? `${g.assetCount} assets extracted so far`
              : "Reading archive...",
          });
        } catch {
          /* transient network error, keep polling */
        }
      }
      setStage("error");
      setError("Extraction timed out");
      return { ok: false, warning: null };
    },
    []
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!file) {
        setError("Please select a file to upload");
        return;
      }

      setError(null);
      setPercent(0);
      setStage("uploading");
      setPhase({
        label: "Uploading",
        detail: `0 B of ${formatBytes(file.size)}`,
      });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const id = await uploadFileChunked(file, gameName, {
          signal: controller.signal,
          onProgress: (p, uploaded, total) => {
            setPercent(p);
            setPhase({
              label: "Uploading",
              detail: `${formatBytes(uploaded)} of ${formatBytes(total)}`,
            });
          },
          onRetry: (chunkIndex, totalChunks, attempt, max) => {
            setRetryInfo(
              `Chunk ${chunkIndex + 1}/${totalChunks} failed — retrying (${attempt}/${max})`
            );
            setTimeout(() => setRetryInfo(null), 6000);
          },
          onChunkStart: (chunkIndex, totalChunks) => {
            setCurrentChunk({ index: chunkIndex, total: totalChunks });
          },
        });
        setRetryInfo(null);

        setStage("extracting");
        setPercent(0);
        setPhase({ label: "Extracting assets", detail: "Reading archive..." });

        const result = await pollUntilReady(id);
        if (result.ok) {
          // Linger longer when there is a warning the user should read.
          setTimeout(() => {
            if (aliveRef.current) router.push(`/play/${id}`);
          }, result.warning ? 4000 : 800);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setStage("idle");
          setPhase({ label: "", detail: "" });
          setError("Upload cancelled");
        } else {
          setStage("error");
          setError(err instanceof Error ? err.message : "Upload failed");
        }
      } finally {
        abortRef.current = null;
      }
    },
    [file, gameName, pollUntilReady, router]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        setFile(e.target.files[0]);
        setError(null);
        setStage("idle");
        setPercent(0);
      }
      // Clear the input so picking the same file again still fires onChange.
      e.target.value = "";
    },
    []
  );

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setFile(e.dataTransfer.files[0]);
      setError(null);
      setStage("idle");
      setPercent(0);
    }
  }, []);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <div className="text-3xl">🎮</div>
          <h1 className="text-4xl font-bold text-white">Game Asset Extractor</h1>
        </div>
        <p className="text-slate-400 mb-8">
          Upload a game archive. We extract every asset, then serve it back so the
          game runs in your browser.
        </p>

        {stage === "idle" || stage === "error" ? (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div
              className="border-2 border-dashed border-slate-600 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 transition-colors"
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={handleDrop}
            >
              <input
                type="file"
                id="file-upload"
                className="hidden"
                onChange={handleFileChange}
                accept=".zip,.tar,.tgz,.gz,.bz2,.xz,.tbz2,.txz,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp3,.wav,.ogg,.mp4,.webm,.json,.js,.html,.css,.txt,.lua"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <div className="text-6xl mb-4">📦</div>
                <p className="text-xl text-white mb-2">
                  {file ? file.name : "Click to browse or drag & drop your game archive"}
                </p>
                {file && (
                  <p className="text-slate-400 text-sm mb-2">
                    {formatBytes(file.size)} •{" "}
                    {Math.max(1, Math.ceil(file.size / CHUNK_SIZE))} chunks
                  </p>
                )}
                <p className="text-slate-500 text-sm">
                  .ZIP or .TAR archives (multi-GB safe) or a single asset file
                </p>
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-white text-sm font-medium mb-2">
                  Game Name (Optional)
                </label>
                <input
                  type="text"
                  value={gameName}
                  onChange={(e) => setGameName(e.target.value)}
                  placeholder="My Awesome Game"
                  className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={!file}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium py-2 px-6 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  Upload & Extract
                </button>
              </div>
            </div>
          </form>
        ) : (
          <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-white font-semibold text-lg">{phase.label}</p>
                <p className="text-slate-400 text-sm">{phase.detail}</p>
              </div>
              <span className="text-2xl font-mono text-white tabular-nums">
                {Math.floor(percent)}%
              </span>
            </div>

            <div className="h-3 w-full bg-slate-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-200 ${
                  stage === "extracting"
                    ? "bg-gradient-to-r from-amber-500 to-amber-300 bg-[length:200%_100%] animate-pulse"
                    : "bg-gradient-to-r from-blue-600 to-cyan-400"
                }`}
                style={{ width: `${Math.max(2, percent)}%` }}
              />
            </div>

            <div className="flex items-center gap-3 mt-4 text-sm text-slate-400">
              {stage === "uploading" && (
                <>
                  <span className="animate-spin rounded-full h-4 w-4 border-2 border-blue-400 border-t-transparent" />
                  <span>Uploading in 16MB chunks — a stalled chunk retries automatically.</span>
                </>
              )}
              {stage === "extracting" && (
                <>
                  <span className="animate-spin rounded-full h-4 w-4 border-2 border-amber-400 border-t-transparent" />
                  <span>Unpacking assets from the archive…</span>
                </>
              )}
              {stage === "done" && (
                <>
                  <span className="text-green-400">✓</span>
                  <span>Done — opening the player…</span>
                </>
              )}
            </div>

            {retryInfo && stage === "uploading" && (
              <div className="mt-3 p-3 bg-amber-900/40 border border-amber-700 rounded-lg text-amber-300 text-sm">
                {retryInfo}
                {currentChunk && (
                  <span className="ml-2 text-amber-400">
                    (Chunk {currentChunk.index + 1}/{currentChunk.total})
                  </span>
                )}
              </div>
            )}

            {stage === "uploading" && (
              <button
                onClick={handleCancel}
                className="mt-6 text-sm text-slate-400 hover:text-white underline"
              >
                Cancel upload
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="mt-6 p-4 bg-red-950/60 border border-red-700 rounded-lg text-red-300">
            <p className="font-medium mb-1">Error</p>
            <p className="text-sm">{error}</p>
            {stage === "error" && (
              <button
                onClick={reset}
                className="mt-3 text-sm underline hover:text-white"
              >
                Start over
              </button>
            )}
          </div>
        )}

        <div className="mt-12">
          <h2 className="text-2xl font-bold text-white mb-4">How It Works</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-slate-800/60 border border-slate-700 p-6 rounded-lg">
              <div className="text-3xl mb-3">📤</div>
              <h3 className="text-xl font-semibold text-white mb-2">Upload</h3>
              <p className="text-slate-400 text-sm">
                Your archive is split into 16MB chunks and streamed to the server.
                Multi-gigabyte files are safe — the server only holds a few chunks in memory at a time.
              </p>
            </div>
            <div className="bg-slate-800/60 border border-slate-700 p-6 rounded-lg">
              <div className="text-3xl mb-3">🗂️</div>
              <h3 className="text-xl font-semibold text-white mb-2">Extract</h3>
              <p className="text-slate-400 text-sm">
                The archive is read with a streaming parser and written straight to
                disk, with every file checksum-verified. Every asset is catalogued
                with its type and size.
              </p>
            </div>
            <div className="bg-slate-800/60 border border-slate-700 p-6 rounded-lg">
              <div className="text-3xl mb-3">▶️</div>
              <h3 className="text-xl font-semibold text-white mb-2">Play</h3>
              <p className="text-slate-400 text-sm">
                The game is served from a path-preserving route, so relative
                URLs inside the game work and it runs directly in the browser.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
