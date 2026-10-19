"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { formatBytes } from "@/lib/format";

interface AssetEntry {
  path: string;
  size: number;
  type: string;
}

interface GameData {
  id: number;
  name: string;
  originalFilename: string;
  status: "uploading" | "extracting" | "ready" | "error";
  progress: number;
  assetCount: number;
  totalSize: number;
  extractionError: string | null;
  entryPoint: string | null;
  assetManifest: Record<string, AssetEntry> | null;
  createdAt: string;
  updatedAt: string;
}

const TYPE_ICON: Record<string, string> = {
  image: "🖼️",
  audio: "🔊",
  video: "🎬",
  script: "📜",
  text: "📄",
  font: "🔠",
  other: "📦",
};

const TYPE_COLOR: Record<string, string> = {
  image: "bg-purple-600/80 hover:bg-purple-500",
  audio: "bg-orange-600/80 hover:bg-orange-500",
  video: "bg-red-600/80 hover:bg-red-500",
  script: "bg-yellow-600/80 hover:bg-yellow-500",
  text: "bg-blue-600/80 hover:bg-blue-500",
  font: "bg-teal-600/80 hover:bg-teal-500",
  other: "bg-slate-600/80 hover:bg-slate-500",
};

/**
 * Optional: serve games from a different origin (e.g. https://games.example.com)
 * so game code can never touch this app's own origin. See README.
 */
const GAME_ORIGIN = (process.env.NEXT_PUBLIC_GAME_ORIGIN ?? "").replace(/\/$/, "");

/** Largest slice of a text/script asset downloaded for the preview pane. */
const PREVIEW_BYTES = 200_000;

/**
 * Untrusted game code runs inside a sandboxed iframe. Without
 * `allow-same-origin` it gets an opaque origin, so it cannot call this app's
 * API (which would otherwise let any game delete the whole library).
 */
const SANDBOX_BASE =
  "allow-scripts allow-pointer-lock allow-popups allow-forms allow-modals allow-downloads allow-orientation-lock allow-presentation";

export default function GamePlayerPage() {
  const params = useParams();
  const router = useRouter();
  const gameId = params.id as string;

  const [game, setGame] = useState<GameData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"play" | "assets">("play");
  const [selected, setSelected] = useState<AssetEntry | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [previewTruncated, setPreviewTruncated] = useState(false);
  // Games that need localStorage/IndexedDB can be run with same-origin access.
  const [trusted, setTrusted] = useState(false);

  const statusRef = useRef<string>("");
  const hasGameRef = useRef(false);
  const notFoundRef = useRef(false);
  const previewSeq = useRef(0);

  const fetchGame = useCallback(async () => {
    try {
      const res = await fetch(`/api/games/${gameId}`, { cache: "no-store" });
      if (res.status === 404) {
        notFoundRef.current = true;
        setGame(null);
        setError("Game not found");
        return;
      }
      if (!res.ok) throw new Error("Failed to load game");
      setGame(await res.json());
      setError(null);
    } catch (err) {
      // A single failed poll must not replace a game that is already on screen.
      if (!hasGameRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load game");
      }
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  // Poll while the server is still working
  useEffect(() => {
    statusRef.current = game?.status ?? "";
    hasGameRef.current = game !== null;
  }, [game]);

  useEffect(() => {
    fetchGame();
    const timer = setInterval(() => {
      if (notFoundRef.current) return;
      if (statusRef.current === "ready" || statusRef.current === "error") return;
      fetchGame();
    }, 1500);
    return () => clearInterval(timer);
  }, [fetchGame]);

  const assets = useMemo(() => {
    const manifest = game?.assetManifest ?? {};
    return Object.values(manifest);
  }, [game]);

  const filteredAssets = useMemo(() => {
    return assets.filter((a) => {
      const typeOk = filter === "all" || a.type === filter;
      const searchOk =
        !search || a.path.toLowerCase().includes(search.toLowerCase());
      return typeOk && searchOk;
    });
  }, [assets, filter, search]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of assets) counts[a.type] = (counts[a.type] ?? 0) + 1;
    return counts;
  }, [assets]);

  const openAsset = useCallback(
    async (asset: AssetEntry) => {
      const seq = ++previewSeq.current; // ignore results from an older click
      setSelected(asset);
      setPreviewUrl(null);
      setPreviewText(null);
      setPreviewTruncated(false);

      const url = `/api/games/${gameId}/raw/${asset.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;

      if (asset.type === "image" || asset.type === "audio" || asset.type === "video") {
        setPreviewUrl(url);
      } else if (asset.type === "text" || asset.type === "script") {
        try {
          // Ask only for the first slice; the server supports Range requests.
          const res = await fetch(url, { headers: { Range: `bytes=0-${PREVIEW_BYTES - 1}` } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          if (seq !== previewSeq.current) return;
          setPreviewText(text.slice(0, PREVIEW_BYTES));
          setPreviewTruncated(asset.size > PREVIEW_BYTES);
        } catch {
          if (seq !== previewSeq.current) return;
          setPreviewText("Could not load file contents.");
        }
      } else {
        setPreviewUrl(url);
      }
    },
    [gameId]
  );

  const handleDelete = useCallback(async () => {
    if (!confirm("Delete this game and all extracted assets?")) return;
    try {
      const res = await fetch(`/api/games/${gameId}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/games");
      } else {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Delete failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }, [gameId, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4" />
          <p className="text-slate-400">Loading game…</p>
        </div>
      </div>
    );
  }

  if (error || !game) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-xl text-red-400 mb-4">{error ?? "Game not found"}</p>
          <button
            onClick={() => router.push("/games")}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg"
          >
            Back to library
          </button>
        </div>
      </div>
    );
  }

  const isReady = game.status === "ready";
  const gamePath = game.entryPoint
    ? `/api/games/${game.id}/raw/${game.entryPoint
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`
    : null;
  const gameSrc = gamePath ? `${GAME_ORIGIN}${gamePath}` : null;
  // ?trusted=1 tells the server to let this page keep its own origin (see raw route).
  const iframeSrc = gameSrc && trusted && !GAME_ORIGIN ? `${gameSrc}?trusted=1` : gameSrc;
  const sameOriginAllowed = Boolean(GAME_ORIGIN) || trusted;
  const sandbox = sameOriginAllowed ? `${SANDBOX_BASE} allow-same-origin` : SANDBOX_BASE;

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Top bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-4 py-3 flex flex-wrap items-center gap-3 sticky top-0 z-20">
        <button
          onClick={() => router.push("/games")}
          className="text-slate-400 hover:text-white text-sm"
        >
          ← Library
        </button>
        <div className="w-px h-6 bg-slate-700" />
        <h1 className="font-semibold text-white truncate max-w-xs">{game.name}</h1>
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            isReady
              ? "bg-green-600/20 text-green-400"
              : game.status === "error"
              ? "bg-red-600/20 text-red-400"
              : "bg-amber-600/20 text-amber-400"
          }`}
        >
          {isReady ? "ready" : game.status}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {gameSrc && (
            <>
              {view === "play" && !GAME_ORIGIN && (
                <button
                  onClick={() => {
                    if (trusted) {
                      setTrusted(false);
                    } else if (
                      confirm(
                        "Enable storage access?\n\nSome games need localStorage/IndexedDB to run. This lets the game run with this site's origin, so ONLY do it for games you trust."
                      )
                    ) {
                      setTrusted(true);
                    }
                  }}
                  title="Games that need localStorage or IndexedDB must run with same-origin access"
                  className={`text-sm px-3 py-1.5 rounded-lg ${
                    trusted
                      ? "bg-amber-600/30 text-amber-300 hover:bg-amber-600/40"
                      : "bg-slate-700 hover:bg-slate-600 text-white"
                  }`}
                >
                  {trusted ? "Storage access: on" : "Allow storage"}
                </button>
              )}
              <button
                onClick={() => setView(view === "play" ? "assets" : "play")}
                className="bg-slate-700 hover:bg-slate-600 text-white text-sm px-3 py-1.5 rounded-lg"
              >
                {view === "play" ? "View assets" : "Back to game"}
              </button>
              <a
                href={gameSrc}
                target="_blank"
                rel="noreferrer"
                className="bg-slate-700 hover:bg-slate-600 text-white text-sm px-3 py-1.5 rounded-lg"
              >
                Open ↗
              </a>
            </>
          )}
          <button
            onClick={handleDelete}
            className="bg-red-600/20 hover:bg-red-600/40 text-red-300 text-sm px-3 py-1.5 rounded-lg"
          >
            Delete
          </button>
        </div>
      </header>

      {isReady && game.extractionError && (
        <div className="bg-amber-900/40 border-b border-amber-700 text-amber-300 text-sm px-4 py-2">
          ⚠ {game.extractionError}
        </div>
      )}

      {/* Processing state */}
      {!isReady && (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="w-full max-w-md text-center">
            {game.status === "error" ? (
              <>
                <div className="text-5xl mb-4">⚠️</div>
                <p className="text-red-400 mb-2">Extraction failed</p>
                <p className="text-slate-400 text-sm mb-6">
                  {game.extractionError ?? "Unknown error"}
                </p>
                <button
                  onClick={() => router.push("/upload")}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg"
                >
                  Upload another
                </button>
              </>
            ) : (
              <>
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-400 mx-auto mb-4" />
                <p className="text-white mb-1">Extracting assets…</p>
                <p className="text-slate-400 text-sm mb-6">
                  {game.assetCount > 0
                    ? `${game.assetCount} files extracted so far (${game.progress}%)`
                    : "Reading the archive…"}
                </p>
                <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-500 transition-all duration-500"
                    style={{ width: `${Math.max(3, game.progress)}%` }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Game view */}
      {isReady && view === "play" && gameSrc && (
        <main className="flex-1 flex flex-col bg-black">
          <iframe
            key={iframeSrc ?? gameSrc}
            src={iframeSrc ?? gameSrc}
            className="flex-1 w-full border-0"
            title={game.name}
            allow="autoplay; fullscreen; gamepad; cross-origin-isolated"
            sandbox={sandbox}
          />
        </main>
      )}

      {isReady && view === "play" && !gameSrc && (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <div className="text-5xl mb-4">🕹️</div>
            <p className="text-white text-lg mb-2">No playable entry point</p>
            <p className="text-slate-400 text-sm mb-6">
              This archive has no HTML entry point, so there is nothing to run
              directly. Browse the {assets.length} extracted assets instead.
            </p>
            <button
              onClick={() => setView("assets")}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg"
            >
              Browse assets
            </button>
          </div>
        </div>
      )}

      {/* Asset browser */}
      {isReady && view === "assets" && (
        <main className="flex-1 p-6">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <Stat label="Assets" value={String(assets.length)} />
              <Stat label="Archive" value={formatBytes(game.totalSize)} />
              <Stat
                label="Entry point"
                value={game.entryPoint ? "HTML ✓" : "none"}
              />
              <Stat label="Status" value={game.status} />
            </div>

            <div className="flex flex-wrap gap-2 mb-6 items-center">
              <button
                onClick={() => setFilter("all")}
                className={`px-3 py-1.5 rounded-lg text-sm ${
                  filter === "all"
                    ? "bg-blue-600 text-white"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                All ({assets.length})
              </button>
              {Object.entries(typeCounts).map(([type, count]) => (
                <button
                  key={type}
                  onClick={() => setFilter(type)}
                  className={`px-3 py-1.5 rounded-lg text-sm ${
                    filter === type
                      ? "bg-blue-600 text-white"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  {TYPE_ICON[type] ?? "📦"} {type} ({count})
                </button>
              ))}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search assets…"
                className="ml-auto px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 min-w-[220px]"
              />
            </div>

            {filteredAssets.length === 0 ? (
              <p className="text-slate-500 text-center py-12">No assets match.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                {filteredAssets.map((asset) => (
                  <button
                    key={asset.path}
                    onClick={() => openAsset(asset)}
                    className={`${TYPE_COLOR[asset.type] ?? TYPE_COLOR.other} rounded-lg p-3 text-left transition-colors`}
                  >
                    <div className="text-xl mb-1">
                      {TYPE_ICON[asset.type] ?? "📦"}
                    </div>
                    <div className="text-white text-xs font-medium truncate">
                      {asset.path.split("/").pop()}
                    </div>
                    <div className="text-white/60 text-[11px] truncate">
                      {asset.path.includes("/")
                        ? asset.path.slice(0, asset.path.lastIndexOf("/"))
                        : "root"}
                    </div>
                    <div className="text-white/70 text-[11px] mt-1">
                      {formatBytes(asset.size)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </main>
      )}

      {/* Asset preview modal */}
      {selected && (
        <div
          className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-slate-900 rounded-xl max-w-4xl w-full max-h-[88vh] overflow-hidden flex flex-col border border-slate-700"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center p-4 border-b border-slate-700 gap-4">
              <div className="min-w-0">
                <p className="text-white font-medium text-sm truncate">
                  {selected.path}
                </p>
                <p className="text-slate-500 text-xs">
                  {selected.type} • {formatBytes(selected.size)}
                </p>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-slate-400 hover:text-white text-2xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="p-4 overflow-auto">
              {selected.type === "image" && previewUrl && (
                <img
                  src={previewUrl}
                  alt={selected.path}
                  className="max-w-full max-h-[65vh] object-contain mx-auto"
                />
              )}
              {selected.type === "audio" && previewUrl && (
                <audio controls className="w-full">
                  <source src={previewUrl} />
                </audio>
              )}
              {selected.type === "video" && previewUrl && (
                <video controls className="w-full max-h-[65vh]">
                  <source src={previewUrl} />
                </video>
              )}
              {(selected.type === "text" || selected.type === "script") && (
                <pre className="bg-slate-950 p-4 rounded-lg text-xs text-slate-200 overflow-auto max-h-[65vh] whitespace-pre-wrap">
                  {previewText ?? "Loading…"}
                </pre>
              )}
              {previewTruncated && (
                <p className="text-slate-500 text-xs mt-2">
                  Showing the first {formatBytes(PREVIEW_BYTES)} of {formatBytes(selected.size)}.
                </p>
              )}
              {(selected.type === "other" || selected.type === "font") && previewUrl && (
                <div className="text-center py-8">
                  <p className="text-slate-400 mb-4">
                    No inline preview for this file type.
                  </p>
                  <a
                    href={previewUrl}
                    download
                    className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm"
                  >
                    Download file
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
        {label}
      </p>
      <p className="text-white font-semibold truncate">{value}</p>
    </div>
  );
}
