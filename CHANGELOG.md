# Changelog

## 1.0.0 – bug-fix and hardening release

### Upload
- **Fixed:** Cancel and the chunk timeout hung the upload forever (promise never settled).
  Cancel now aborts in-flight requests and tells the server to delete partial data; a
  stalled chunk (no bytes for 60 s) now retries. Non-retryable errors (4xx) are surfaced
  with the server's message instead of being retried.
- **Fixed:** race condition where concurrent chunk requests overwrote each other's
  metadata, causing "upload incomplete/corrupted" errors.
- **Fixed:** `x-upload-id` was used unvalidated in file paths (path traversal). Ids must
  be UUIDs; chunk index/count/size are validated; `NaN`/`Infinity` rejected.
- Finalize verifies the real file size on disk, is idempotent on retry, and uses the
  upload id for the destination directory. Stale partial uploads are cleaned hourly.
- Chunk size is a single shared constant (was duplicated on client and server).

### Extraction
- **Fixed:** failed/corrupt entries were recorded as successfully extracted and advanced
  the reader twice. Each entry is now handled once; failures are removed and reported.
- **Fixed:** archives where only *some* entries used an unsupported compression method
  silently lost files. Now falls back to `unzip` and reports anything still missing.
- **Fixed:** zip-bomb limit trusted sizes declared by the archive; real bytes are counted.
- Added CRC-32 verification (yauzl does not check it).
- Symlinks are never created (also removed after `unzip`/`tar`), `__MACOSX`/`.DS_Store`
  are dropped, tar archives are no longer copied into their own extract directory.
- Progress is real (per game) instead of a constant 50, and file counts update live.
- Misleading error messages fixed (`"eof"` matched file names such as `geofence.png`;
  zip-slip/size skips were labelled "unsupported compression method").
- Entry-point detection: `.htm` supported, conventional names beat unrelated pages.
- Extraction failures can no longer cause unhandled rejections; interrupted extractions
  are marked failed after a restart; deleting a game cancels a running extraction.

### Serving and playback
- HTTP Range support, streaming (no whole-file reads), ETag/304, correct MIME types,
  pre-compressed assets, symlink-safe path containment (`realpath`), cached DB lookup.
- `<base>` injection fixed for special characters and `<header>` tags; root-relative
  HTML URLs rewritten; non-UTF-8 pages re-encoded correctly.
- Sandbox: games no longer run with `allow-same-origin` by default (they could delete the
  whole library); CSP `sandbox` header protects the "Open" button too.
- Player: fonts no longer show a blank modal, `.wasm` is no longer previewed as text,
  previews fetch only the first 200 KB, stale-preview race fixed, transient poll failures
  no longer replace the page with an error.

### Project
- Removed the broken direct-upload endpoint (and `formidable`), unused `jszip`/`dotenv`
  usage, duplicate helpers and dead code.
- The list endpoint no longer returns every game's full asset manifest.
- Optional HTTP Basic auth, cross-site request rejection on mutating routes.
- Database connection is lazy (builds work without `DATABASE_URL`); table auto-created;
  schema columns are `NOT NULL`; `drizzle.config.ts` reads `DATABASE_URL`.
- Added Dockerfile, docker-compose.yml, `.env.example`, `.gitignore`, README.
