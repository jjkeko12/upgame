"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { formatBytes } from "@/lib/format";

interface GameRow {
  id: number;
  name: string;
  originalFilename: string;
  status: string;
  progress: number;
  assetCount: number;
  totalSize: number;
  extractionError: string | null;
  entryPoint: string | null;
  createdAt: string;
}

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-green-600/20 text-green-400",
  extracting: "bg-amber-600/20 text-amber-400",
  uploading: "bg-blue-600/20 text-blue-400",
  error: "bg-red-600/20 text-red-400",
};

export default function GamesListPage() {
  const [games, setGames] = useState<GameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  // Mirrors `games` so the poll timer can read it without side effects inside a state updater.
  const gamesRef = useRef<GameRow[]>([]);

  const fetchGames = useCallback(async () => {
    try {
      const res = await fetch("/api/games", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to fetch games");
      const data: GameRow[] = await res.json();
      gamesRef.current = data;
      setGames(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load games");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGames();
    const timer = setInterval(() => {
      if (gamesRef.current.some((g) => g.status === "extracting" || g.status === "uploading")) {
        fetchGames();
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [fetchGames]);

  const handleDelete = useCallback(
    async (gameId: number) => {
      if (!confirm("Delete this game and all extracted assets?")) return;
      try {
        const res = await fetch(`/api/games/${gameId}`, { method: "DELETE" });
        if (res.ok) {
          fetchGames();
        } else {
          const body = await res.json().catch(() => null);
          setError(body?.error || "Failed to delete game");
        }
      } catch {
        setError("Failed to delete game");
      }
    },
    [fetchGames]
  );

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white">Game Library</h1>
            <p className="text-slate-400">All uploaded games</p>
          </div>
          <button
            onClick={() => router.push("/upload")}
            className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg transition-colors"
          >
            + Upload Game
          </button>
        </div>

        {loading ? (
          <div className="text-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white mx-auto mb-4" />
            <p className="text-slate-400">Loading…</p>
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <p className="text-red-400 mb-4">{error}</p>
            <button
              onClick={fetchGames}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg"
            >
              Retry
            </button>
          </div>
        ) : games.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-6xl mb-4">🎮</div>
            <p className="text-xl text-slate-400 mb-6">No games uploaded yet</p>
            <button
              onClick={() => router.push("/upload")}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg"
            >
              Upload your first game
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {games.map((game) => (
              <div
                key={game.id}
                className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-colors"
              >
                <div className="flex justify-between items-start gap-3 mb-3">
                  <h2 className="text-lg font-semibold text-white truncate">
                    {game.name}
                  </h2>
                  <span
                    className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_STYLE[game.status] ?? "bg-slate-700 text-slate-300"
                    }`}
                  >
                    {game.status}
                  </span>
                </div>

                <p className="text-slate-500 text-xs truncate mb-3">
                  {game.originalFilename}
                </p>

                {game.status === "extracting" && (
                  <div className="mb-3">
                    <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-500 transition-all duration-500"
                        style={{ width: `${Math.max(3, game.progress ?? 0)}%` }}
                      />
                    </div>
                    <p className="text-slate-500 text-xs mt-1">
                      {game.progress ?? 0}% — {game.assetCount} files so far
                    </p>
                  </div>
                )}

                {game.status === "error" && game.extractionError && (
                  <p className="text-red-400 text-xs mb-3 line-clamp-3">{game.extractionError}</p>
                )}
                {game.status === "ready" && game.extractionError && (
                  <p className="text-amber-400 text-xs mb-3 line-clamp-3">⚠ {game.extractionError}</p>
                )}

                <div className="space-y-1 mb-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Archive</span>
                    <span className="text-slate-300">
                      {formatBytes(game.totalSize)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Assets</span>
                    <span className="text-slate-300">{game.assetCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Playable</span>
                    <span className="text-slate-300">
                      {game.entryPoint ? "Yes" : "No"}
                    </span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => router.push(`/play/${game.id}`)}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-lg text-sm transition-colors"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => handleDelete(game.id)}
                    className="bg-red-600/20 hover:bg-red-600/40 text-red-300 py-2 px-4 rounded-lg text-sm transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
