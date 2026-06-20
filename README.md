# MuscleMemory Magazine Parser

Express API that extracts article page ranges from PDF magazines stored in S3 and returns a new PDF containing just the requested pages.

## How It Works

The main MuscleMemory service issues a signed JWT containing the magazine filename, page range, title, and author. This service verifies the token, downloads the source magazine from S3, extracts the specified pages using `pdf-lib`, and streams back the resulting PDF.

Generated PDFs are kept in an in-memory LRU cache (10 entries) to avoid re-extracting the same article on repeated requests.

On startup, the service fetches magazine series-code-to-name mappings from the main MuscleMemory API to populate PDF subject metadata.

## Setup

```bash
npm install
cp .env.example .env  # then fill in values
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Server port (use `3001` in production) |
| `VERSION` | No | | Version string reported by `/pdf/version` |
| `AWS_REGION` | No | `us-east-1` | AWS region for S3 |
| `S3_BUCKET_NAME` | Yes | | S3 bucket containing source magazine PDFs |
| `MAG_PARSER_SECRET` | Yes | | Shared HMAC secret for verifying JWTs from the MuscleMemory service |

## Development

```bash
npm run dev        # nodemon + ts-node, watches src/**/*.ts
npm run build      # compile TypeScript to dist/
npm run lint       # ESLint
npm test           # Jest
```

## Production

```bash
npm run bundle-prod   # esbuild bundle + production deps into dist/
PORT=3001 node dist/bundle.js
```

## API

All routes are under `/pdf`.

### `GET /pdf`

Extract an article from a magazine PDF.

**Query:** `token` - JWT signed with `MAG_PARSER_SECRET` containing `{ mag, pageRange, title, author, exp }` and optionally `{ year, month, volume, issue }`.

**Response:** `200` with `application/pdf` body, or `400`/`401`/`500` JSON error.

### `GET /pdf/version`

Returns `{ version, date, internal }`.

### `GET /pdf/stats`

Returns `{ initializedAt, articles }` - server uptime and articles served.
