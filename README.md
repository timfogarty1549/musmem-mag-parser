# MuscleMemory Magazine Parser

Express API that extracts article page ranges from PDF magazines stored in S3 and returns a new PDF containing just the requested pages. Also serves individual magazine pages as JPEG images for the page viewer.

## How It Works

The main MuscleMemory service issues a signed JWT containing the magazine filename, page range, title, and author. This service verifies the token, downloads the source magazine from S3, extracts the specified pages using `qpdf`, sets metadata via `pdf-lib`, and streams back the resulting PDF.

Generated article PDFs are kept in an in-memory LRU cache (50MB). Source magazines are cached on disk (4GB LRU). Page images are cached on disk (6GB LRU).

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
| `MAG_CACHE_DIR` | No | `/tmp/mag-cache/` | Directory for disk-cached source magazines (see production values below) |
| `MAG_PAGE_CACHE_DIR` | No | `/tmp/mag-pages/` | Directory for disk-cached page images (see production values below) |

### Production environment variables

On EC2, `/tmp` is a tmpfs backed by RAM. Cache directories must point to the real filesystem:

```
MAG_CACHE_DIR=/var/cache/mag-parser
MAG_PAGE_CACHE_DIR=/var/cache/mag-pages
```

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

## EC2 Configuration

The service runs on a t4g.micro (1GB RAM, ARM/Graviton). The following setup is required.

### System dependencies

```bash
sudo yum install -y qpdf poppler-utils
```

### Cache directories

```bash
sudo mkdir -p /var/cache/mag-parser /var/cache/mag-pages
sudo chown ec2-user:ec2-user /var/cache/mag-parser /var/cache/mag-pages
```

### Swap file

The instance has no swap by default. Without swap, concurrent `pdftoppm`/`qpdf` processes can exhaust memory and freeze the instance with no recovery (can't SSH, can't reboot from console).

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=1024
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
```

### systemd service

Copy `mag-parser.service` to `/etc/systemd/system/` and reload:

```bash
sudo cp mag-parser.service /etc/systemd/system/mag-parser.service
sudo systemctl daemon-reload
sudo systemctl restart mag-parser
```

The service file includes `MemoryHigh=600M` and `MemoryMax=768M` to keep enough RAM free for the OS and SSH if the service runs away.

## API

All routes are under `/pdf`. Bot/crawler user agents are blocked with 403.

### `GET /pdf`

Extract an article from a magazine PDF.

**Query:** `token` - JWT signed with `MAG_PARSER_SECRET` containing `{ mag, pageRange, title, author, exp }` and optionally `{ year, month, volume, issue }`.

**Response:** `200` with `application/pdf` body, or `400`/`401`/`500` JSON error.

### `GET /pdf/page`

Render a single magazine page as a JPEG image.

**Query:** `token` - JWT with `{ mag, totalPages, exp }`. `page` - 1-indexed page number.

**Response:** `200` with `image/jpeg` body, or `400`/`401`/`500` JSON error.

### `GET /pdf/page/info`

Get the total page count for a magazine.

**Query:** `token` - JWT with `{ mag, totalPages, exp }`.

**Response:** `200` with `{ totalPages }`.

### `GET /pdf/version`

Returns `{ version, date, internal }`.

### `GET /pdf/stats`

Returns `{ initializedAt, articles, pages }` - server uptime and counts served.
