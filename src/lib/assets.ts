import type { AssetEntry, AssetType } from "@/db/schema";

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"];
const AUDIO_EXT = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus"];
const VIDEO_EXT = [".mp4", ".webm", ".mov", ".avi", ".mkv", ".ogv"];
const SCRIPT_EXT = [".js", ".mjs", ".cjs", ".ts", ".json", ".lua", ".py"];
const TEXT_EXT = [".txt", ".xml", ".csv", ".html", ".htm", ".css", ".md", ".glsl", ".shader", ".frag", ".vert"];
const FONT_EXT = [".woff", ".woff2", ".ttf", ".otf", ".eot"];

export function getAssetType(filename: string): AssetType {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return "other";
  const ext = lower.slice(dot);
  if (IMAGE_EXT.includes(ext)) return "image";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (SCRIPT_EXT.includes(ext)) return "script";
  if (FONT_EXT.includes(ext)) return "font";
  if (TEXT_EXT.includes(ext)) return "text";
  // .wasm, .jsdata, .bin, .pck ... are binary and must not be previewed as text
  return "other";
}

/** OS metadata that archivers add; never useful as game assets. */
export function isJunkPath(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, "/").split("/");
  const base = parts[parts.length - 1].toLowerCase();
  return (
    parts[0] === "__MACOSX" ||
    base === ".ds_store" ||
    base === "thumbs.db" ||
    base === "desktop.ini" ||
    base.startsWith("._")
  );
}

/** File names that usually mean "start the game here", best first. */
const ENTRY_NAMES = ["index.html", "index.htm", "main.html", "game.html", "play.html", "start.html"];

const depthOf = (p: string) => p.split("/").length;
const nameRank = (p: string) => ENTRY_NAMES.indexOf(p.split("/").pop()!.toLowerCase());

/**
 * Finds the most likely HTML entry point inside an extracted asset map.
 * Files with a conventional entry name win over unrelated pages (credits.html),
 * and shallower paths win over deeper ones, so a single wrapper folder is fine.
 */
export function findEntryPoint(manifest: Record<string, AssetEntry>): string | null {
  const htmlFiles = Object.keys(manifest).filter((p) => !isJunkPath(p) && /\.html?$/i.test(p));
  if (htmlFiles.length === 0) return null;

  const named = htmlFiles.filter((p) => nameRank(p) !== -1);
  const pool = named.length > 0 ? named : htmlFiles;

  return [...pool].sort((a, b) => {
    const da = depthOf(a) - depthOf(b);
    if (da !== 0) return da;
    const ra = nameRank(a) === -1 ? 99 : nameRank(a);
    const rb = nameRank(b) === -1 ? 99 : nameRank(b);
    if (ra !== rb) return ra - rb;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  })[0];
}
