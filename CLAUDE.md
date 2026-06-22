# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` - run with nodemon + ts-node, watching `src/**/*.ts`
- `npm run build` - compile TypeScript to `dist/` via `tsc`
- `npm start` - run compiled output (`dist/index.js`)
- `npm run bundle` - bundle `src/index.ts` into `dist/bundle.js` with esbuild (all deps inlined)
- `npm run bundle-prod` - bundle and then install production deps into `dist/`
- `npm test` - run Jest (no test files currently exist; `*.spec.ts` is excluded from `tsc` build)
- `npm run lint` - run ESLint over `.ts` files (no ESLint config file currently present in the repo despite the dependency)

## Architecture

This is an Express API that extracts specific page ranges from PDF magazines stored in S3 and streams back a new PDF containing just the requested article.

Request flow: `src/index.ts` (app setup: helmet CSP, CORS, rate limiting) → `src/routes.ts` (`/pdf` router) → `src/CreatePdfComponent.ts` (core logic). Article metadata (magazine filename, page range, title, author, optional date/volume/issue) arrives per-request as a JWT signed by the `musmem` service, decoded via `src/MagParserPayload.ts`. On startup, `MagCodeService` fetches magazine-code-to-name mappings from the main `musmem` API.

- **`src/index.ts`** - Express app entry point. Configures helmet (CSP allows assets/connections to `s3.musclememory.net`/`.org`, plus Google reCAPTCHA scripts), CORS (allowlist of `musclememory.*` domains and local Angular dev server), and two layered rate limiters (`/pdf`: 30 req/10s and 1000 req/hour). Initializes `MagCodeService` before starting the server. Also sets up global error handling and graceful shutdown on `SIGTERM`/`SIGINT`.
- **`src/routes.ts`** - Defines the `/pdf` router:
  - `GET /version` - returns `process.env.VERSION` and the mtime of `dist/bundle.js`.
  - `GET /stats` - returns uptime and article-served count from `StatsService`.
  - `GET /` - verifies a JWT (`MAG_PARSER_SECRET`) from the `token` query parameter and returns a generated PDF (`application/pdf`) containing only that article's pages.
- **`src/CreatePdfComponent.ts`** - `CreatePdfComponent` does the actual PDF work:
  - Maintains an in-memory LRU cache (`maxCacheSize = 10`) of generated article PDFs, keyed by a SHA-256 hash of the payload's `mag` filename and `pageRange` string.
  - `ensureMagOnDisk()` checks the `DiskCacheService` for a cached copy; on miss, streams the source magazine PDF from S3 directly to disk (never buffering the full file in memory) via `@aws-sdk/client-s3`. A `HeadObject` pre-flight check rejects missing keys fast and enforces a 200MB size limit.
  - Page extraction uses `QpdfService` (wraps the `qpdf` CLI) to extract only the requested pages into a temp file — memory-efficient (~20MB) regardless of source magazine size.
  - `pdf-lib` is used solely on the small extracted article (~2-10MB) to set metadata (title, author, subject with magazine name/month/year/volume/issue, producer/creator).
  - Maintains an in-memory LRU cache (50MB) of generated article PDFs and a disk-based LRU cache (1.5GB) of source magazines.
- **`src/MagParserPayload.ts`** - `MagParserPayload` interface (`mag`, `pageRange`, `title`, `author`, `exp`, plus optional `year`, `month`, `volume`, `issue`) describing the decoded JWT payload; `parsePageRange()` expands a `pageRange` string (e.g. `"1-5,63-65"`) into a `number[]` of 1-indexed page numbers; `isValidPayload()` validates the payload's shape (including that `pageRange` parses successfully) before use.
- **`src/services/DiskCacheService.ts`** - LRU disk cache for source magazine PDFs. Stores files in `MAG_CACHE_DIR` (default `/tmp/mag-cache/`), keyed by SHA-256 hash of the S3 key. Evicts oldest files before writing when total size would exceed the 1.5GB limit. Supports both `put()` (from buffer) and `putFile()` (move/copy existing file).
- **`src/services/QpdfService.ts`** - Wraps the `qpdf` CLI tool for memory-efficient page extraction. `extractPages()` runs `qpdf` with a 30s timeout. `buildPageArg()` collapses consecutive page numbers into ranges (e.g. `[5,6,63,64,68]` → `"5-6,63-64,68"`). `isAvailable()` checks if qpdf is installed (called on startup).
- **`src/services/MagCodeService.ts`** - Singleton that fetches magazine series-code-to-name mappings from the main `musmem` API (`/api/mags/codes`) on startup, with retry logic (up to 6 attempts, 10s apart). Exposes `getName(code)` to resolve a series code (e.g. directory name in the S3 key) to a human-readable magazine title.
- **`src/services/StatsService.ts`** - Singleton tracking server uptime (`initializedAt`) and total articles served (`articleCount`). Exposed via `GET /pdf/stats`.
- **`src/services/logger.ts`** - Winston logger (timestamped, pretty-printed, console transport) used throughout for `info`/`warn`/`error`/`debug` logging.
- **`src/utils/helper.ts`** - `Helper.getErrorMessage()` normalizes `unknown` caught errors into a string message.

## Routes

All routes are mounted under `/pdf` (see `src/routes.ts`).

### `GET /pdf/version`

- **Input:** none.
- **Output:** `200 application/json`
  - `version` - value of `process.env.VERSION`.
  - `date` - ISO timestamp of `dist/bundle.js`'s mtime, or `null` if the file can't be stat'd.
  - `internal` - hardcoded value (`1234`), omitted when the file stat fails.

### `GET /pdf/stats`

- **Input:** none.
- **Output:** `200 application/json`
  - `initializedAt` - ISO timestamp of when the server started.
  - `articles` - number of articles served since startup.

### `GET /pdf`

- **Input:** `token=<jwt>` query parameter, a JWT signed by `musmem` with `MAG_PARSER_SECRET`, containing the payload `{ mag, pageRange, title, author, exp }` plus optional `{ year, month, volume, issue }` (see `src/MagParserPayload.ts`). `pageRange` is a string of 1-indexed pages/ranges, e.g. `"1-5,63-65"`.
- **Output:**
  - `200 application/pdf` - the extracted article PDF as a binary stream, with `Content-Disposition: attachment; filename="<magId>_<title>.pdf"` (spaces replaced with hyphens, `magId` is the basename of the magazine filename without `.pdf`).
  - `400 application/json` - `{ "error": "Missing token" }` if `token` is absent or not a string, or `{ "error": "Failed to fetch article", "details": <message> }` if the magazine isn't found or extraction fails.
  - `401 application/json` - `{ "error": "Invalid or expired token" }` if JWT verification fails, or `{ "error": "Invalid token payload" }` if the decoded payload fails shape validation.
  - `500 application/json` - `{ "error": "Failed to parse PDF", "details": <message> }` on unexpected errors, or if `MAG_PARSER_SECRET` is not configured.

## Environment variables

- `PORT` - server port (default 3000)
- `VERSION` - reported by `/pdf/version`
- `AWS_REGION` - region for the S3 client (default `us-east-1`)
- `S3_BUCKET_NAME` - bucket containing source magazine PDFs
- `MAG_PARSER_SECRET` - shared HMAC secret for verifying JWTs issued by `musmem` (signed payload: `{ mag, pageRange, title, author, exp }`)
- `MAG_CACHE_DIR` - directory for disk-cached source magazines (default: `/tmp/mag-cache/`)

## Notes

- Module imports within `src/` use extensionless relative paths (e.g. `./services/logger`), matching the `musmem` repo's convention. `tsc`'s `NodeNext` module resolution accepts this for CommonJS packages (no `"type": "module"` in `package.json`).
- `tsconfig.json` excludes `**/*.spec.ts` from compilation, anticipating colocated Jest spec files.

## EC2 Configuration

to use qpdf
`
sudo yum install -y qpdf
sudo mkdir /var/cache/mag-parser
sudo chown $(whoami):$(whoami) /var/cache/mag-parser
`