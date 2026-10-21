# Game Asset Extraction & Playback

Upload a game archive (ZIP, TAR/TGZ, or a single file), have every asset extracted
and catalogued, then play the game in the browser or browse its assets.

- **Resilient chunked uploads** – 16 MB chunks, 3 in parallel, automatic retry with
  backoff, stall detection, working cancel, byte-accurate progress, server-side
  integrity check. Multi-GB files are fine.
- **Safe extraction** – streaming ZIP reader (never loads the archive into memory),
  CRC-32 verification, real-byte size cap (zip-bomb guard), zip-slip and symlink
  protection, OS junk (`__MACOSX`, `.DS_Store`) removed. Entries yauzl can't read
  (bzip2/lzma) automatically fall back to the system `unzip`. Anything that could not
  be extracted is reported on the game, never silently dropped.
- **Proper file serving** – HTTP `Range` (video/audio seeking, Safari), streaming from
  disk, ETag/304, pre-compressed `.gz`/`.br` assets (Unity WebGL), correct MIME types.
- **Sandboxed playback** – games run in a sandboxed iframe with an opaque origin and a
  CSP `sandbox` header, so uploaded code cannot call this app's API.

- **Automatic launcher pages** – if an archive has no HTML page, the app looks for a
  browser-playable layout and generates one: Unity WebGL builds (high confidence),
  classic Emscripten/WebAssembly builds (medium), and plain JavaScript games (low:
  load order and page elements are guessed). Generated pages are named
  `index.generated.html` and flagged on the game. If nothing fits, the game page
  explains why (native `.exe`/`.dll`, Flash, Java, engine source projects, console
  ROMs, assets-only archives, and so on).

## Quick start (local)

Requirements: Node.js >= 20.9, PostgreSQL, and the `unzip` + `tar` binaries
(preinstalled on macOS/most Linux).

```bash
cp .env.example .env        # then edit DATABASE_URL
npm install
npm run dev                 # http://localhost:3000
```

The `games` table is created automatically on first start. (`npm run db:push` also works
if you prefer Drizzle migrations while changing the schema.)

## Docker (recommended for hosting)

```bash
docker compose up --build   # app on http://localhost:3000, Postgres + data in volumes
```

Set `AUTH_PASSWORD` to password-protect the app:

```bash
AUTH_PASSWORD='something-long' docker compose up --build
```

The image can run anywhere that runs containers (a VPS, Railway, Render, Fly.io, ...).
You need **a persistent volume mounted at `/data`** and a Postgres database.

> **Reverse proxy:** each upload request is up to 16 MB. nginx defaults to 1 MB, so set
> `client_max_body_size 20m;` (or the equivalent in Caddy/Traefik/Cloudflare tunnels).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | – (required) | Postgres connection string |
| `DATABASE_SSL` | off | `true` for hosted Postgres that requires TLS |
| `DATA_DIR` | working dir | Where `uploads/` and `extracts/` live (mount a volume here) |
| `MAX_UPLOAD_BYTES` | 10 GB | Largest accepted upload |
| `MAX_EXTRACT_BYTES` | 20 GB | Largest total extracted size |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | off | HTTP Basic auth for the library, uploads and deletes |
| `NEXT_PUBLIC_GAME_ORIGIN` | off | Serve games from a separate origin (build-time) |

## Security model

- Uploaded games are **untrusted code**. By default they run sandboxed with an opaque
  origin; mutating API routes also reject cross-site/`null`-origin requests.
- Some games need `localStorage`/IndexedDB. The player has an **Allow storage** toggle
  that runs that one game with same-origin access – use it only for games you trust.
- For full isolation, host games on a second origin (e.g. `games.example.com` pointing
  at the same server) and build with `NEXT_PUBLIC_GAME_ORIGIN=https://games.example.com`.
  Games then keep working storage *and* cannot reach the app.
- Set `AUTH_PASSWORD` for anything reachable from the internet. Without it, anyone who
  can reach the site can upload and delete. Raw game files (`/api/games/<id>/raw/...`)
  stay public by design (sandboxed games can't send credentials); ids are sequential.

## Deploying to Vercel – read this first

This app **cannot run on Vercel as written**, because it relies on things serverless
functions don't provide:

| App needs | Vercel Functions |
|---|---|
| 16 MB request bodies | hard limit of **4.5 MB** per request |
| Persistent disk for archives and extracted games | read-only filesystem (only ephemeral `/tmp`) |
| Extraction running after the HTTP response returns | execution stops when the response ends |
| One process holding upload state | many isolated instances |

You *can* host a **frontend-only** deployment on Vercel that talks to a backend running
elsewhere, or redesign storage around object storage (e.g. Vercel Blob/S3 with direct
browser uploads) plus a separate extraction worker. Use the Docker route above for the
current design.

## Known limitations

- **Single server instance.** Upload locking and extraction jobs are in-process.
- **Root-relative URLs inside JavaScript** (e.g. `fetch("/data.json")`) cannot be
  rewritten. Root-relative `src`/`href` in HTML *are* rewritten. Games built with an
  absolute base path may need a rebuild with a relative base (`base: "./"` in Vite).
- Password-protected ZIPs are rejected. Extraction restarts from scratch if the server
  restarts mid-way (the game is marked failed so you can re-upload).

## Project layout

```
src/app/api/games/            list, get/delete, chunk upload, finalize, raw file server
src/lib/chunks.ts             chunk store (locked, atomic metadata, id-validated)
src/lib/extract.ts            streaming ZIP extraction + unzip/tar fallbacks
src/lib/process.ts            background extraction jobs
src/lib/serve.ts              Range parsing, path containment, HTML rewriting, MIME
src/lib/upload-client.ts      browser uploader
src/lib/bootstrap.ts          table creation, crash recovery, stale-upload cleanup
src/instrumentation.ts        runs bootstrap once per server start
```
