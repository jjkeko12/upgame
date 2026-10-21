import fsp from "fs/promises";
import path from "path";
import type { AssetEntry } from "@/db/schema";
import type { ExtractResult } from "@/lib/extract";
import { getAssetType, isJunkPath } from "@/lib/assets";
import { isInside } from "@/lib/utils";

/**
 * Entry-point synthesis for archives that contain no HTML page.
 *
 * A browser can only run web technology (HTML/JS/WebAssembly). So when an
 * archive has no page, we look for a recognised browser-playable layout and
 * generate a small launcher page for it. If nothing matches we explain why the
 * game cannot run in a browser instead of failing silently.
 *
 * Confidence differs per layout and is reported to the user:
 *   Unity WebGL      - high   (fixed, documented file layout)
 *   Emscripten       - medium (classic, non-modularized builds only)
 *   Plain JavaScript - low    (guesses load order and page elements)
 */

export type SynthesizedKind = "unity" | "emscripten" | "javascript";

export interface SynthesizedEntry {
  /** Path of the generated page, relative to the game root ("/" separators). */
  path: string;
  html: string;
  kind: SynthesizedKind;
  /** Shown to the user next to the game. */
  note: string;
}

export interface EntryAnalysis {
  synthesized: SynthesizedEntry | null;
  /** Set when nothing could be synthesized: a human readable explanation. */
  reason: string | null;
}

/** Reads up to `maxBytes` from the start of a file (as text). Injected so this module stays pure. */
export type HeadReader = (relPath: string, maxBytes: number) => Promise<string>;

const posix = path.posix;
const HEAD_BYTES = 512 * 1024;
const MAX_SCRIPTS = 40;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Safe to embed inside an inline <script>. */
const jsString = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");

/** URL of `file` relative to the page's directory, percent-encoded per segment. */
function relUrl(pageDir: string, file: string): string {
  const rel = pageDir ? posix.relative(pageDir, file) : file;
  return rel.split("/").map(encodeURIComponent).join("/");
}

const depth = (p: string) => p.split("/").length;
const byDepthThenName = (a: string, b: string) => depth(a) - depth(b) || a.localeCompare(b);
const dirOf = (p: string) => {
  const d = posix.dirname(p);
  return d === "." ? "" : d;
};
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

function pageShell(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${escHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
  canvas { display: block; }
</style>
${head}</head>
<body>
${body}</body>
</html>
`;
}

/* ------------------------------------------------------------------ Unity */

interface UnityLayout {
  pageDir: string;
  loader: string;
  framework: string;
  data: string;
  wasm: string;
  hasStreamingAssets: boolean;
}

/** Modern Unity WebGL (2020+): <name>.loader.js + .framework.js + .data + .wasm (optionally .gz / .br). */
function detectUnity(files: string[]): { layout?: UnityLayout; problem?: string } {
  const loaders = files.filter((p) => /\.loader\.js$/i.test(p)).sort(byDepthThenName);
  let problem: string | undefined;

  for (const loader of loaders) {
    const dir = dirOf(loader);
    const stem = posix.basename(loader).replace(/\.loader\.js$/i, "");
    const siblings = files.filter((p) => dirOf(p) === dir);
    const find = (suffix: string) =>
      siblings.find((p) => new RegExp(`^${escapeRe(stem)}\\.${suffix}(\\.gz|\\.br)?$`, "i").test(posix.basename(p)));

    const framework = find("framework\\.js");
    const data = find("data");
    const wasm = find("wasm");

    if (framework && data && wasm) {
      const pageDir = posix.basename(dir).toLowerCase() === "build" ? dirOf(dir) : dir;
      const streaming = join(pageDir, "StreamingAssets/");
      return {
        layout: {
          pageDir,
          loader,
          framework,
          data,
          wasm,
          hasStreamingAssets: files.some((p) => p.startsWith(streaming)),
        },
      };
    }

    const unityweb = siblings.some((p) => p.startsWith(`${dir ? dir + "/" : ""}${stem}.`) && /\.unityweb$/i.test(p));
    problem = unityweb
      ? "This looks like a Unity WebGL build that uses .unityweb compression. That needs server headers configured for the exact compression the build used, so it can't be started automatically."
      : "This looks like a Unity WebGL build, but some of its files (framework, data or wasm) are missing, so it can't start.";
  }
  return { problem };
}

function unityHtml(title: string, u: UnityLayout): { html: string; note: string } {
  const url = (f: string) => jsString(relUrl(u.pageDir, f));
  const usesBrotli = [u.framework, u.data, u.wasm].some((f) => f.toLowerCase().endsWith(".br"));
  const config = [
    `dataUrl: ${url(u.data)}`,
    `frameworkUrl: ${url(u.framework)}`,
    `codeUrl: ${url(u.wasm)}`,
    u.hasStreamingAssets ? `streamingAssetsUrl: "StreamingAssets"` : null,
    `companyName: "Unknown"`,
    `productName: ${jsString(title)}`,
    `productVersion: "1.0"`,
  ]
    .filter(Boolean)
    .join(",\n      ");

  const html = pageShell(
    title,
    `<style>#unity-canvas { width: 100%; height: 100%; background: #231f20; }
  #unity-status { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #ddd; font: 16px system-ui, sans-serif; pointer-events: none; }</style>
`,
    `<canvas id="unity-canvas" tabindex="-1"></canvas>
<div id="unity-status">Loading…</div>
<script src="${escHtml(relUrl(u.pageDir, u.loader))}"></script>
<script>
  var status = document.getElementById("unity-status");
  createUnityInstance(document.getElementById("unity-canvas"), {
      ${config}
    }, function (progress) {
      status.textContent = "Loading… " + Math.round(progress * 100) + "%";
    }).then(function () {
      status.remove();
    }).catch(function (err) {
      status.textContent = "Could not start the game: " + err;
    });
</script>
`
  );

  const note =
    "No HTML page was found, so a launcher was generated automatically for this Unity WebGL build." +
    (usesBrotli ? " It uses Brotli (.br) files, which browsers only accept over HTTPS." : "");
  return { html, note };
}

/* ------------------------------------------------------------- Emscripten */

interface EmscriptenLayout {
  pageDir: string;
  js: string;
}

/**
 * Classic Emscripten output: <name>.js (glue) next to <name>.wasm.
 * Only the classic form (global `Module`) is supported; MODULARIZE builds are not.
 */
async function detectEmscripten(
  files: string[],
  readHead: HeadReader
): Promise<{ layout?: EmscriptenLayout; problem?: string }> {
  const wasmFiles = files.filter((p) => /\.wasm$/i.test(p)).sort(byDepthThenName);
  let problem: string | undefined;

  for (const wasm of wasmFiles) {
    const js = wasm.replace(/\.wasm$/i, ".js");
    if (!files.includes(js)) {
      problem = problem ?? "A WebAssembly file (.wasm) was found, but no matching JavaScript loader next to it, so it can't be started.";
      continue;
    }
    const head = await readHead(js, HEAD_BYTES);
    const looksEmscripten = /emscripten|wasmBinaryFile|wasmMemory|instantiateStreaming/i.test(head);
    if (!looksEmscripten) continue;

    const classic = /var\s+Module\s*=\s*typeof\s+Module/.test(head);
    if (!classic) {
      problem = "This looks like a modularized Emscripten build. Those need custom start-up code that depends on how the game was compiled, so a launcher can't be guessed.";
      continue;
    }
    return { layout: { pageDir: dirOf(js), js } };
  }
  return { problem };
}

function emscriptenHtml(title: string, e: EmscriptenLayout): { html: string; note: string } {
  const html = pageShell(
    title,
    `<style>#canvas { width: 100%; height: 100%; background: #000; }</style>
`,
    `<canvas id="canvas" tabindex="-1" oncontextmenu="event.preventDefault()"></canvas>
<script>
  var Module = {
    canvas: document.getElementById("canvas"),
    print: function (t) { console.log(t); },
    printErr: function (t) { console.error(t); }
  };
</script>
<script async src="${escHtml(relUrl(e.pageDir, e.js))}"></script>
`
  );
  return {
    html,
    note: "No HTML page was found, so a launcher was generated for this Emscripten (WebAssembly) build. This is a best guess, and it may not start if the game expects custom page elements.",
  };
}

/* ------------------------------------------------------------- Plain JS */

const ENTRY_JS_NAMES = ["game.js", "main.js", "index.js", "app.js", "bundle.js", "script.js", "start.js", "init.js"];
const LIB_RE = /phaser|three|pixi|jquery|howler|babylon|p5|kaboom|matter|lodash|vendor|jszip|gsap|tween|stats|kontra|melon|crafty|impact|createjs|easel|sound/i;
const SKIP_RE = /(^|[\\/._-])(test|tests|spec|server|webpack|gulp|grunt|rollup|vite|eslint|karma)([\\/._-]|$)/i;
const NODE_ONLY_RE = /require\(\s*["'](fs|path|electron|child_process|os|http|net)["']\s*\)/;
const BROWSER_API_RE = /\b(document|window|requestAnimationFrame|getElementById|querySelector|canvas|WebGL|navigator|Audio|localStorage)\b/;

interface JsLayout {
  pageDir: string;
  entry: string;
  scripts: string[];
  isModule: boolean;
  styles: string[];
  elements: string[];
}

async function detectPlainJs(
  files: string[],
  readHead: HeadReader
): Promise<{ layout?: JsLayout; problem?: string }> {
  const jsFiles = files.filter((p) => /\.(js|mjs)$/i.test(p));
  if (jsFiles.length === 0) return {};

  // Pick the entry: a conventional name wins, shallowest first.
  const rank = (p: string) => {
    const i = ENTRY_JS_NAMES.indexOf(posix.basename(p).toLowerCase());
    return i === -1 ? 99 : i;
  };
  const candidates = jsFiles.filter((p) => rank(p) !== 99 && !SKIP_RE.test(p));
  if (candidates.length === 0) {
    return {
      problem: "JavaScript files were found, but none has a conventional start-up name (main.js, game.js, index.js...), so there is no safe way to guess which one starts the game.",
    };
  }
  candidates.sort((a, b) => depth(a) - depth(b) || rank(a) - rank(b) || a.localeCompare(b));
  const entry = candidates[0];
  const pageDir = dirOf(entry);

  const entryHead = await readHead(entry, HEAD_BYTES);
  if (NODE_ONLY_RE.test(entryHead)) {
    return { problem: "The JavaScript here is written for Node.js or Electron (it uses modules like fs or electron), not for a browser, so it can't run in a page." };
  }
  if (!BROWSER_API_RE.test(entryHead)) {
    return { problem: "The main JavaScript file doesn't appear to use any browser features (document, window, canvas...), so it's not clear it is a browser game." };
  }

  const isModule = /^\s*(import|export)\s/m.test(entryHead);

  // Other scripts in the entry's folder tree: libraries first, then the rest alphabetically.
  const inTree = jsFiles.filter(
    (p) => p !== entry && (pageDir === "" || p.startsWith(`${pageDir}/`)) && !SKIP_RE.test(p)
  );
  const libs = inTree.filter((p) => LIB_RE.test(posix.basename(p))).sort(byDepthThenName);
  const others = inTree.filter((p) => !LIB_RE.test(posix.basename(p))).sort(byDepthThenName);
  const scripts = isModule ? [] : [...libs, ...others];
  if (scripts.length + 1 > MAX_SCRIPTS) {
    return { problem: `There are more than ${MAX_SCRIPTS} separate script files, which is too many to guess a safe load order for.` };
  }

  // Stylesheets next to the entry.
  const styles = files
    .filter((p) => /\.css$/i.test(p) && (pageDir === "" || p.startsWith(`${pageDir}/`)))
    .filter((p) => /^(style|styles|main|index|game|app)\.css$/i.test(posix.basename(p)))
    .sort(byDepthThenName)
    .slice(0, 3);

  // Page elements the code looks up by id, so it doesn't crash on a missing node.
  const sources = [entryHead];
  for (const s of scripts.slice(0, 10)) sources.push(await readHead(s, 128 * 1024));
  const combined = sources.join("\n");
  const elements: string[] = [];
  const seen = new Set<string>();
  const idRe = /(?:getElementById\(\s*["']([\w-]+)["']\s*\)|querySelector\(\s*["']#([\w-]+)["']\s*\))/g;
  for (const m of combined.matchAll(idRe)) {
    const id = m[1] ?? m[2];
    if (seen.has(id) || ["body", "html", "head"].includes(id)) continue;
    seen.add(id);
    const after = combined.slice(m.index ?? 0, (m.index ?? 0) + 300);
    elements.push(/getContext\s*\(/.test(after) ? `<canvas id="${escHtml(id)}"></canvas>` : `<div id="${escHtml(id)}"></div>`);
    if (elements.length >= 12) break;
  }
  if (elements.length === 0 && /querySelector\(\s*["']canvas["']\s*\)|getElementsByTagName\(\s*["']canvas["']\s*\)/.test(combined)) {
    elements.push("<canvas></canvas>");
  }

  return { layout: { pageDir, entry, scripts, isModule, styles, elements } };
}

function plainJsHtml(title: string, j: JsLayout): { html: string; note: string } {
  const head = j.styles.map((s) => `<link rel="stylesheet" href="${escHtml(relUrl(j.pageDir, s))}">\n`).join("");
  const scriptTags = [
    ...j.scripts.map((s) => `<script src="${escHtml(relUrl(j.pageDir, s))}"></script>`),
    j.isModule
      ? `<script type="module" src="${escHtml(relUrl(j.pageDir, j.entry))}"></script>`
      : `<script src="${escHtml(relUrl(j.pageDir, j.entry))}"></script>`,
  ].join("\n");
  const body = `${j.elements.join("\n")}${j.elements.length ? "\n" : ""}${scriptTags}\n`;
  return {
    html: pageShell(title, head, body),
    note: `No HTML page was found, so a basic page was generated that loads ${posix.basename(j.entry)}${
      j.scripts.length ? ` and ${j.scripts.length} other script(s)` : ""
    }. This is a low-confidence guess at the page structure and script order, so the game may not start.`,
  };
}

/* ------------------------------------------------- "why it can't run" */

const has = (files: string[], re: RegExp) => files.some((p) => re.test(p));

/** A specific explanation of why this archive cannot run in a browser. */
export function explainNoEntryPoint(files: string[]): string {
  const reasons: string[] = [];

  if (has(files, /\.(exe|dll|msi|bat|cmd)$/i) || has(files, /\.(so|dylib|appimage)$/i) || has(files, /(^|\/)[^/]+\.app\//i)) {
    reasons.push("It contains native programs (such as .exe or .dll files). A browser can't run Windows, macOS or Linux programs. The game would need a browser (HTML5/WebGL) export from its developer or engine.");
  }
  if (has(files, /\.jar$/i)) {
    reasons.push("It contains Java programs (.jar), which a browser can't run without a Java runtime.");
  }
  if (has(files, /\.swf$/i)) {
    reasons.push("It contains Adobe Flash files (.swf). Flash is discontinued, and running it needs an emulator such as Ruffle, which this app doesn't include.");
  }
  if (has(files, /\.(love)$/i)) {
    reasons.push("It's a LÖVE game (.love), which needs the LÖVE engine, or a web port of it, to run.");
  }
  if (has(files, /(^|\/)renpy\//i) || has(files, /\.(rpa|rpyc)$/i)) {
    reasons.push("It's a Ren'Py visual novel, which runs through its own desktop engine and has no browser export here.");
  }
  if (has(files, /(^|\/)project\.godot$/i) || (has(files, /(^|\/)ProjectSettings\//) && has(files, /\.unity$/i))) {
    reasons.push("It's an engine project (source files), not a built game. It needs to be exported for the web from Godot or Unity first.");
  }
  if (has(files, /\.pck$/i) && !has(files, /\.wasm$/i)) {
    reasons.push("It has a Godot data file (.pck) but no web runtime (.wasm), so it isn't a web export.");
  }
  if (has(files, /\.(nes|sfc|smc|gba|gbc|gb|nds|n64|z64|iso|cue)$/i)) {
    reasons.push("It contains console ROM or disc images, which need an emulator. This app doesn't include one.");
  }
  if (has(files, /(^|\/)package\.json$/i) && has(files, /\.(js|mjs)$/i)) {
    reasons.push("It looks like a Node.js or desktop (Electron) project rather than a web page.");
  }
  if (has(files, /(^|\/)UnityLoader\.js$/i)) {
    reasons.push("It's an old Unity WebGL build (UnityLoader.js, from before 2020), which uses a different start-up method that can't be generated automatically.");
  }

  if (reasons.length > 0) return reasons.slice(0, 3).join(" ");

  const codeLike = has(files, /\.(js|mjs|wasm|html?)$/i);
  const allKnownAssets = files.length > 0 && files.every((p) => getAssetType(p) !== "other");
  if (!codeLike && allKnownAssets) {
    return "It contains only assets (images, audio, video, fonts or data) and no code, so there is nothing to run. You can still browse and download everything in the Assets view.";
  }
  return "No HTML page was found, and the files don't match any browser-playable layout this app recognises. You can still browse the extracted files in the Assets view.";
}

/* -------------------------------------------------------------- Public API */

/**
 * Tries to create a launcher page for an archive with no HTML entry point.
 * Never throws for "can't do it": returns a reason instead.
 */
export async function analyzeMissingEntryPoint(
  manifest: Record<string, AssetEntry>,
  readHead: HeadReader,
  title = "Game"
): Promise<EntryAnalysis> {
  const files = Object.keys(manifest).filter((p) => !isJunkPath(p));
  const pageName = (dir: string) => join(dir, "index.generated.html");
  const unique = (dir: string) => {
    let name = pageName(dir);
    for (let i = 2; files.includes(name); i++) name = join(dir, `index.generated-${i}.html`);
    return name;
  };

  const problems: string[] = [];

  const unity = detectUnity(files);
  if (unity.layout) {
    const { html, note } = unityHtml(title, unity.layout);
    return { synthesized: { path: unique(unity.layout.pageDir), html, kind: "unity", note }, reason: null };
  }
  if (unity.problem) problems.push(unity.problem);

  const emscripten = await detectEmscripten(files, readHead);
  if (emscripten.layout) {
    const { html, note } = emscriptenHtml(title, emscripten.layout);
    return { synthesized: { path: unique(emscripten.layout.pageDir), html, kind: "emscripten", note }, reason: null };
  }
  if (emscripten.problem) problems.push(emscripten.problem);

  const js = await detectPlainJs(files, readHead);
  if (js.layout) {
    const { html, note } = plainJsHtml(title, js.layout);
    return { synthesized: { path: unique(js.layout.pageDir), html, kind: "javascript", note }, reason: null };
  }
  if (js.problem) problems.push(js.problem);

  // Specific blockers found while trying come first, then the general explanation.
  const general = explainNoEntryPoint(files);
  const reason = problems.length > 0 ? `${problems[0]} ${general.startsWith("No HTML page") ? "" : general}`.trim() : general;
  return { synthesized: null, reason };
}

/** Reads the start of a file inside `root`, refusing anything that resolves outside it. */
async function readHeadFrom(root: string, relPath: string, maxBytes: number): Promise<string> {
  const target = path.resolve(root, ...relPath.split("/"));
  if (!isInside(root, target)) return "";
  const fh = await fsp.open(target, "r").catch(() => null);
  if (!fh) return "";
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Called after extraction. If the game has no HTML entry point, analyses it and
 * either writes a generated launcher page into the game (updating `result`) or
 * returns an explanation of why it can't run. Returns the message to show the
 * user, or null when the game already had an entry point.
 */
export async function ensureEntryPoint(
  result: ExtractResult,
  extractPath: string,
  title: string
): Promise<string | null> {
  if (result.entryPoint) return null;

  const analysis = await analyzeMissingEntryPoint(
    result.manifest,
    (rel, max) => readHeadFrom(extractPath, rel, max),
    title
  );

  if (!analysis.synthesized) return analysis.reason;

  const gen = analysis.synthesized;
  const target = path.resolve(extractPath, ...gen.path.split("/"));
  if (!isInside(extractPath, target)) return analysis.reason ?? null;

  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, gen.html, "utf8");

  const size = Buffer.byteLength(gen.html, "utf8");
  result.manifest[gen.path] = { path: gen.path, size, type: getAssetType(gen.path) };
  result.fileCount += 1;
  result.totalBytes += size;
  result.entryPoint = gen.path;
  return gen.note;
}
