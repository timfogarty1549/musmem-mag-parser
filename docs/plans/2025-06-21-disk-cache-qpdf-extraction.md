# Disk-Cached Magazine + qpdf Page Extraction

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace in-memory PDF loading with disk-cached source magazines and `qpdf` CLI-based page extraction, reducing peak memory from ~500MB to ~50MB per request.

**Architecture:** Source magazines are downloaded from S3 to a local disk cache (`/tmp/mag-cache/`) on first access. Subsequent requests for the same magazine skip S3 entirely. Page extraction uses `qpdf` (a memory-efficient CLI tool) to pull only the requested pages into a small temp file. `pdf-lib` is then used solely on the small extracted article (~2-10MB) to set metadata (title, author, subject, etc.). An LRU disk cache with configurable max size evicts the oldest magazines when disk space exceeds the limit.

**Tech Stack:** Node.js, TypeScript, `child_process.execFile` (for qpdf), `fs/promises`, existing `@aws-sdk/client-s3`, `pdf-lib` (metadata only), Express.

---

## Prerequisites

`qpdf` must be installed on the EC2 instance (Amazon Linux):

```bash
sudo yum install -y qpdf
```

Verify: `qpdf --version` should return 10.x+.

The `qpdf` page extraction command format:
```bash
qpdf input.pdf --pages . 5-6,63-65,68 -- output.pdf
```

This reads only the referenced page objects from the input file — it does NOT load the full PDF into memory.

---

## Task 1: Create DiskCacheService

**Files:**
- Create: `src/services/DiskCacheService.ts`
- Test: `src/services/DiskCacheService.spec.ts`

This service manages the on-disk magazine cache in `/tmp/mag-cache/`. It tracks files by last-access time and evicts the oldest when total size exceeds the limit.

**Step 1: Write the failing test**

```typescript
// src/services/DiskCacheService.spec.ts
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { DiskCacheService } from './DiskCacheService';

describe('DiskCacheService', () => {
  let cacheDir: string;
  let service: DiskCacheService;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mag-cache-test-'));
    service = new DiskCacheService(cacheDir, 1024); // 1KB max for testing
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('returns null for uncached files', async () => {
    const result = await service.get('nonexistent.pdf');
    expect(result).toBeNull();
  });

  it('stores and retrieves a file', async () => {
    const data = Buffer.from('fake pdf content');
    await service.put('test.pdf', data);
    const result = await service.get('test.pdf');
    expect(result).not.toBeNull();
    const content = await fs.readFile(result!);
    expect(content).toEqual(data);
  });

  it('evicts oldest files when over size limit', async () => {
    const big = Buffer.alloc(600, 'A'); // 600 bytes
    await service.put('first.pdf', big);
    await service.put('second.pdf', big); // total 1200 > 1024 limit
    const first = await service.get('first.pdf');
    const second = await service.get('second.pdf');
    expect(first).toBeNull(); // evicted
    expect(second).not.toBeNull();
  });

  it('converts S3 key to safe filename', async () => {
    const data = Buffer.from('content');
    await service.put('series/subdir/magazine.pdf', data);
    const result = await service.get('series/subdir/magazine.pdf');
    expect(result).not.toBeNull();
    // Should not contain path separators in the cached filename
    const filename = path.basename(result!);
    expect(filename).not.toContain('/');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest src/services/DiskCacheService.spec.ts --no-coverage`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/services/DiskCacheService.ts
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import logger from './logger';

export class DiskCacheService {
  private readonly cacheDir: string;
  private readonly maxBytes: number;

  constructor(cacheDir: string, maxBytes: number) {
    this.cacheDir = cacheDir;
    this.maxBytes = maxBytes;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async get(s3Key: string): Promise<string | null> {
    const filePath = this.keyToPath(s3Key);
    try {
      await fs.access(filePath);
      // Touch atime to mark as recently used
      const now = new Date();
      await fs.utimes(filePath, now, now);
      return filePath;
    } catch {
      return null;
    }
  }

  async put(s3Key: string, data: Buffer): Promise<string> {
    await this.initialize();
    await this.evictToFit(data.length);
    const filePath = this.keyToPath(s3Key);
    await fs.writeFile(filePath, data);
    return filePath;
  }

  async getSize(): Promise<number> {
    try {
      const files = await fs.readdir(this.cacheDir);
      let total = 0;
      for (const file of files) {
        const stat = await fs.stat(path.join(this.cacheDir, file));
        total += stat.size;
      }
      return total;
    } catch {
      return 0;
    }
  }

  private keyToPath(s3Key: string): string {
    const hash = crypto.createHash('sha256').update(s3Key).digest('hex').substring(0, 12);
    const safeName = path.basename(s3Key);
    return path.join(this.cacheDir, `${hash}_${safeName}`);
  }

  private async evictToFit(incomingBytes: number): Promise<void> {
    const files = await fs.readdir(this.cacheDir);
    const entries: { path: string; size: number; mtimeMs: number }[] = [];
    let totalSize = 0;

    for (const file of files) {
      const filePath = path.join(this.cacheDir, file);
      const stat = await fs.stat(filePath);
      entries.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      totalSize += stat.size;
    }

    // Evict until there's room for the incoming file
    if (totalSize + incomingBytes <= this.maxBytes) return;

    // Sort oldest first
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const entry of entries) {
      if (totalSize + incomingBytes <= this.maxBytes) break;
      await fs.unlink(entry.path);
      totalSize -= entry.size;
      logger.debug(`Disk cache evicted: ${path.basename(entry.path)}`);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx jest src/services/DiskCacheService.spec.ts --no-coverage`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/services/DiskCacheService.ts src/services/DiskCacheService.spec.ts
git commit -m "feat: add DiskCacheService for on-disk magazine caching"
```

---

## Task 2: Create QpdfService

**Files:**
- Create: `src/services/QpdfService.ts`
- Test: `src/services/QpdfService.spec.ts`

Wraps the `qpdf` CLI tool to extract specific pages from a source PDF file on disk.

**Step 1: Write the failing test**

```typescript
// src/services/QpdfService.spec.ts
import { QpdfService } from './QpdfService';

describe('QpdfService', () => {
  describe('buildPageArg', () => {
    it('converts page numbers array to qpdf page argument', () => {
      // Pages [5, 6, 63, 64, 68] → "5-6,63-64,68"
      const result = QpdfService.buildPageArg([5, 6, 63, 64, 68]);
      expect(result).toBe('5-6,63-64,68');
    });

    it('handles single pages', () => {
      const result = QpdfService.buildPageArg([1, 3, 7]);
      expect(result).toBe('1,3,7');
    });

    it('handles single contiguous range', () => {
      const result = QpdfService.buildPageArg([1, 2, 3, 4, 5]);
      expect(result).toBe('1-5');
    });

    it('handles single page', () => {
      const result = QpdfService.buildPageArg([42]);
      expect(result).toBe('42');
    });
  });

  describe('extractPages', () => {
    it('throws if qpdf is not installed', async () => {
      const service = new QpdfService('/nonexistent/qpdf');
      await expect(
        service.extractPages('/tmp/input.pdf', [1, 2], '/tmp/output.pdf')
      ).rejects.toThrow();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest src/services/QpdfService.spec.ts --no-coverage`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/services/QpdfService.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from './logger';

const execFileAsync = promisify(execFile);

const QPDF_TIMEOUT_MS = 30_000;

export class QpdfService {
  private readonly qpdfPath: string;

  constructor(qpdfPath: string = 'qpdf') {
    this.qpdfPath = qpdfPath;
  }

  async extractPages(inputPath: string, pages: number[], outputPath: string): Promise<void> {
    const pageArg = QpdfService.buildPageArg(pages);

    try {
      await execFileAsync(this.qpdfPath, [
        inputPath,
        '--pages', '.', pageArg, '--',
        outputPath
      ], { timeout: QPDF_TIMEOUT_MS });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`qpdf extraction failed: ${msg}`);
      throw new Error(`Page extraction failed: ${msg}`);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.qpdfPath, ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  static buildPageArg(pages: number[]): string {
    if (pages.length === 0) return '';

    const sorted = [...pages].sort((a, b) => a - b);
    const ranges: string[] = [];
    let rangeStart = sorted[0];
    let rangeEnd = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === rangeEnd + 1) {
        rangeEnd = sorted[i];
      } else {
        ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);
        rangeStart = sorted[i];
        rangeEnd = sorted[i];
      }
    }
    ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);

    return ranges.join(',');
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx jest src/services/QpdfService.spec.ts --no-coverage`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/services/QpdfService.ts src/services/QpdfService.spec.ts
git commit -m "feat: add QpdfService for CLI-based page extraction"
```

---

## Task 3: Refactor CreatePdfComponent to use disk cache + qpdf

**Files:**
- Modify: `src/CreatePdfComponent.ts` (full rewrite of `fetchMag` and `buildArticle`)
- Test: `src/CreatePdfComponent.spec.ts`

The new flow:
1. Check article cache (in-memory, keyed by mag+pages) — return immediately if hit
2. Check disk cache for source magazine — skip S3 if on disk
3. If not on disk: HeadObject to validate, then download to disk cache
4. Use `qpdf` to extract requested pages from disk file → temp file
5. Load small temp file (~2-10MB) with `pdf-lib` to set metadata
6. Cache the final article bytes in memory, return

**Step 1: Write the failing test**

```typescript
// src/CreatePdfComponent.spec.ts
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { CreatePdfComponent } from './CreatePdfComponent';

// This test verifies the integration point — requires qpdf installed
describe('CreatePdfComponent', () => {
  describe('buildArticle flow', () => {
    it('returns 404 status when magazine does not exist in S3', async () => {
      const component = CreatePdfComponent.getInstance();
      const result = await component.fetchArticle({
        mag: 'nonexistent/fake-magazine.pdf',
        pageRange: '1-3',
        title: 'Test Article',
        author: 'Test Author',
        exp: Math.floor(Date.now() / 1000) + 3600
      });
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.status).toBe(404);
      }
    });
  });
});
```

**Step 2: Run test to verify it fails (or passes — this tests existing behavior)**

Run: `npx jest src/CreatePdfComponent.spec.ts --no-coverage`
Expected: PASS (validates existing 404 behavior is preserved)

**Step 3: Rewrite CreatePdfComponent**

Replace the body of `src/CreatePdfComponent.ts` with the following. Key changes marked with `// CHANGED`:

```typescript
// src/CreatePdfComponent.ts
import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PDFDocument } from "pdf-lib";
import logger from "./services/logger";
import MagCodeService from "./services/MagCodeService";
import StatsService from "./services/StatsService";
import { MagParserPayload, parsePageRange } from "./MagParserPayload";
import { DiskCacheService } from "./services/DiskCacheService";
import { QpdfService } from "./services/QpdfService";

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

const MAX_PDF_SIZE_BYTES = 200 * 1024 * 1024;
const MAX_CACHE_BYTES = 50 * 1024 * 1024;       // in-memory article cache
const DISK_CACHE_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5GB — leaves 500MB headroom for temp files + OS
const S3_TIMEOUT_MS = 60_000;                    // longer timeout: writing to disk, not holding in RAM

export class CreatePdfComponent {
    private static instance: CreatePdfComponent;
    private readonly cache = new Map<string, Uint8Array>();
    private cacheBytes = 0;
    private activeRequests = 0;
    private readonly maxActiveRequests = 3; // safe now — qpdf uses minimal memory
    private readonly s3: S3Client;
    private readonly diskCache: DiskCacheService;
    private readonly qpdf: QpdfService;

    private constructor() {
        this.s3 = new S3Client({
            region: process.env.AWS_REGION || 'us-east-1'
        });
        const cacheDir = process.env.MAG_CACHE_DIR || path.join(os.tmpdir(), 'mag-cache');
        this.diskCache = new DiskCacheService(cacheDir, DISK_CACHE_BYTES);
        this.qpdf = new QpdfService();
    }

    public static getInstance(): CreatePdfComponent {
        if (!CreatePdfComponent.instance) {
            CreatePdfComponent.instance = new CreatePdfComponent();
        }
        return CreatePdfComponent.instance;
    }

    public async fetchArticle(payload: MagParserPayload): Promise<{ pdf: Uint8Array } | { error: string; status?: number }> {
        const cacheKey = this.buildCacheKey(payload);
        const cached = this.cache.get(cacheKey);
        if (cached) {
            logger.info(`Article cache hit: ${payload.title}`);
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, cached);
            return { pdf: cached };
        }

        if (this.activeRequests >= this.maxActiveRequests) {
            logger.warn(`Rejecting request: ${this.activeRequests} concurrent PDF builds in progress`);
            return { error: 'Server busy, please retry shortly', status: 503 };
        }

        this.activeRequests++;
        try {
            return await this.buildArticle(payload, cacheKey);
        } finally {
            this.activeRequests--;
        }
    }

    private async buildArticle(payload: MagParserPayload, cacheKey: string): Promise<{ pdf: Uint8Array } | { error: string; status?: number }> {
        // Step 1: Ensure source magazine is on disk
        const magPath = await this.ensureMagOnDisk(payload.mag);
        if (!magPath) {
            return { error: `Magazine not found in S3: ${payload.mag}`, status: 404 };
        }

        // Step 2: Extract pages with qpdf → temp file
        const pages = parsePageRange(payload.pageRange);
        const tempOutput = path.join(os.tmpdir(), `article-${cacheKey.substring(0, 12)}.pdf`);
        try {
            await this.qpdf.extractPages(magPath, pages, tempOutput);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to extract pages ${payload.pageRange} from ${payload.mag}: ${msg}`);
            return { error: `Failed to extract pages ${payload.pageRange} from: ${payload.mag}` };
        }

        // Step 3: Load small extracted article with pdf-lib to set metadata
        try {
            const extractedBytes = await fs.readFile(tempOutput);
            const pdfDoc = await PDFDocument.load(extractedBytes);
            this.setMetadata(pdfDoc, payload);
            const pdfBytes = await pdfDoc.save();

            this.addToCache(cacheKey, pdfBytes);
            StatsService.incrementArticles();
            return { pdf: pdfBytes };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to set metadata on extracted article: ${msg}`);
            return { error: `Failed to create PDF document for: ${payload.title}` };
        } finally {
            // Clean up temp file
            fs.unlink(tempOutput).catch(() => {});
        }
    }

    private async ensureMagOnDisk(s3Key: string): Promise<string | null> {
        // Check disk cache first
        const cachedPath = await this.diskCache.get(s3Key);
        if (cachedPath) {
            logger.debug(`Disk cache hit: ${s3Key}`);
            return cachedPath;
        }

        // Pre-flight: check key exists and size
        try {
            const head = await this.s3.send(new HeadObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME,
                Key: s3Key
            }));

            if (head.ContentLength && head.ContentLength > MAX_PDF_SIZE_BYTES) {
                logger.error(`Magazine "${s3Key}" exceeds size limit: ${Math.round(head.ContentLength / 1024 / 1024)}MB`);
                return null;
            }
        } catch (error: unknown) {
            const name = (error as { name?: string }).name;
            if (name === 'NotFound' || name === 'NoSuchKey') {
                logger.warn(`Magazine not found in S3: bucket=${process.env.S3_BUCKET_NAME}, key=${s3Key}`);
            } else {
                logger.error(`S3 HeadObject error for "${s3Key}": ${(error as Error).message ?? error}`);
            }
            return null;
        }

        // Download to disk cache
        logger.info(`Downloading magazine from S3: ${s3Key}`);
        try {
            const response = await this.s3.send(
                new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: s3Key }),
                { requestTimeout: S3_TIMEOUT_MS }
            );

            if (!response.Body) {
                logger.warn(`Empty response body from S3 for: ${s3Key}`);
                return null;
            }

            const bytes = await response.Body.transformToByteArray();
            const filePath = await this.diskCache.put(s3Key, Buffer.from(bytes));
            logger.info(`Magazine cached to disk: ${s3Key} (${Math.round(bytes.length / 1024 / 1024)}MB)`);
            return filePath;
        } catch (error: unknown) {
            const name = (error as { name?: string }).name;
            if (name === 'TimeoutError') {
                logger.error(`S3 download timed out for "${s3Key}" after ${S3_TIMEOUT_MS}ms`);
            } else {
                logger.error(`S3 download error for "${s3Key}": ${(error as Error).message ?? error}`);
            }
            return null;
        }
    }

    private setMetadata(pdfDoc: PDFDocument, article: MagParserPayload): void {
        pdfDoc.setTitle(article.title);
        pdfDoc.setAuthor(article.author);
        const seriesCode = path.basename(path.dirname(article.mag));
        const magName = MagCodeService.getName(seriesCode);
        if (magName) {
            pdfDoc.setSubject(this.buildSubject(article, magName));
        }
        pdfDoc.setProducer('MuscleMemory.org');
        pdfDoc.setCreator('Tim Fogarty');
        pdfDoc.setCreationDate(new Date());
        pdfDoc.setModificationDate(new Date());
    }

    private buildCacheKey(payload: MagParserPayload): string {
        const raw = `${payload.mag}|${payload.pageRange}`;
        return crypto.createHash('sha256').update(raw).digest('hex');
    }

    private addToCache(cacheKey: string, pdfBytes: Uint8Array): void {
        const entrySize = pdfBytes.byteLength;

        if (entrySize > MAX_CACHE_BYTES / 2) {
            logger.debug(`Article too large to cache (${Math.round(entrySize / 1024 / 1024)}MB)`);
            return;
        }

        if (this.cache.has(cacheKey)) {
            this.cacheBytes -= this.cache.get(cacheKey)!.byteLength;
            this.cache.delete(cacheKey);
        }

        while (this.cacheBytes + entrySize > MAX_CACHE_BYTES && this.cache.size > 0) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) {
                this.cacheBytes -= this.cache.get(firstKey)!.byteLength;
                this.cache.delete(firstKey);
                logger.debug(`Cache evicted article: ${firstKey}`);
            }
        }

        this.cache.set(cacheKey, pdfBytes);
        this.cacheBytes += entrySize;
        logger.debug(`Article cached (${Math.round(entrySize / 1024)}KB). Cache: ${this.cache.size} items, ${Math.round(this.cacheBytes / 1024 / 1024)}MB`);
    }

    private buildSubject(article: MagParserPayload, magName: string): string {
        const parts: string[] = [magName];

        const monthName = article.month != null ? MONTH_NAMES[article.month - 1] : null;
        const year = article.year != null
            ? (article.year < 100 ? 1900 + article.year : article.year)
            : null;

        const dateParts = [monthName, year].filter(Boolean);
        if (dateParts.length > 0) parts.push(dateParts.join(' '));

        const volParts: string[] = [];
        if (article.volume != null) volParts.push(`Vol. ${article.volume}`);
        if (article.issue != null) volParts.push(`No. ${article.issue}`);
        if (volParts.length > 0) parts.push(volParts.join(' '));

        return parts.join(', ');
    }
}
```

**Step 4: Run build to verify compilation**

Run: `npm run build`
Expected: Clean compile, no errors

**Step 5: Run tests**

Run: `npx jest --no-coverage`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/CreatePdfComponent.ts src/CreatePdfComponent.spec.ts
git commit -m "refactor: replace in-memory PDF loading with disk cache + qpdf extraction"
```

---

## Task 4: Add qpdf availability check on startup

**Files:**
- Modify: `src/index.ts` (add startup check)

**Step 1: Add qpdf check after MagCodeService initialization**

In `src/index.ts`, after `MagCodeService.initialize();`, add:

```typescript
import { QpdfService } from './services/QpdfService';

// ... existing code ...

MagCodeService.initialize();

// Verify qpdf is available
const qpdf = new QpdfService();
qpdf.isAvailable().then((available) => {
  if (!available) {
    logger.error('qpdf is not installed or not in PATH. PDF extraction will fail.');
    logger.error('Install with: sudo yum install -y qpdf (AL2) or sudo apt-get install -y qpdf (Debian)');
    process.exit(1);
  }
  logger.info('qpdf available');
});
```

**Step 2: Run build**

Run: `npm run build`
Expected: Clean compile

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: verify qpdf availability on startup"
```

---

## Task 5: Update memory monitoring thresholds

**Files:**
- Modify: `src/index.ts`

With disk-based caching, memory usage should stay much lower. Update the warning threshold.

**Step 1: Lower the memory warning threshold**

Change `MEMORY_WARN_THRESHOLD_MB` from 400 to 200 — if we're using >200MB with this architecture, something is wrong.

**Step 2: Run build**

Run: `npm run build`
Expected: Clean compile

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "chore: lower memory warning threshold to match new architecture"
```

---

## Task 6: Add S3 streaming download to disk

**Files:**
- Modify: `src/CreatePdfComponent.ts` (replace `transformToByteArray` with stream-to-file)

The current implementation still uses `transformToByteArray()` which loads the full PDF into memory before writing to disk. Instead, stream the S3 response body directly to a file.

**Step 1: Replace the download section in `ensureMagOnDisk`**

Replace:
```typescript
const bytes = await response.Body.transformToByteArray();
const filePath = await this.diskCache.put(s3Key, Buffer.from(bytes));
```

With:
```typescript
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';

// Stream directly to disk — never hold full magazine in memory
const tempPath = path.join(os.tmpdir(), `dl-${crypto.randomBytes(8).toString('hex')}.pdf`);
const body = response.Body as Readable;
await pipeline(body, createWriteStream(tempPath));
const stat = await fs.stat(tempPath);
const filePath = await this.diskCache.putFile(s3Key, tempPath);
logger.info(`Magazine cached to disk: ${s3Key} (${Math.round(stat.size / 1024 / 1024)}MB)`);
return filePath;
```

This requires adding a `putFile` method to `DiskCacheService` that moves (renames) an existing temp file into the cache directory instead of writing from a buffer.

**Step 2: Add `putFile` to DiskCacheService**

```typescript
async putFile(s3Key: string, sourcePath: string): Promise<string> {
    await this.initialize();
    const stat = await fs.stat(sourcePath);
    await this.evictToFit(stat.size);
    const filePath = this.keyToPath(s3Key);
    await fs.rename(sourcePath, filePath);
    return filePath;
}
```

**Step 3: Write test for `putFile`**

```typescript
it('moves an existing file into cache via putFile', async () => {
    const tmpFile = path.join(os.tmpdir(), 'test-move.pdf');
    await fs.writeFile(tmpFile, Buffer.from('moved content'));
    const result = await service.putFile('moved.pdf', tmpFile);
    const content = await fs.readFile(result);
    expect(content.toString()).toBe('moved content');
    // Source should no longer exist
    await expect(fs.access(tmpFile)).rejects.toThrow();
});
```

**Step 4: Run tests and build**

Run: `npm run build && npx jest --no-coverage`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/CreatePdfComponent.ts src/services/DiskCacheService.ts src/services/DiskCacheService.spec.ts
git commit -m "feat: stream S3 downloads directly to disk, never hold full magazine in memory"
```

---

## Task 7: Update `maxActiveRequests` and remove old pdf-lib full-load code

**Files:**
- Modify: `src/CreatePdfComponent.ts`

**Step 1: Verify no remaining code loads full magazine with pdf-lib**

Search for any remaining `PDFDocument.load` calls that operate on the full magazine (there should only be one that loads the small extracted article).

Run: `grep -n "PDFDocument.load" src/CreatePdfComponent.ts`
Expected: Only one occurrence, in the `buildArticle` method, loading `extractedBytes` (the small article)

**Step 2: Confirm `maxActiveRequests = 3` is appropriate**

With streaming + qpdf, peak memory per request is roughly:
- qpdf process: ~10-20MB
- Extracted article in pdf-lib: ~5-20MB
- Total per request: ~30MB

Three concurrent = ~90MB. Safe on 1GB.

**Step 3: Commit if any cleanup needed**

```bash
git add src/CreatePdfComponent.ts
git commit -m "chore: clean up obsolete in-memory PDF loading code"
```

---

## Task 8: Add environment variable documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add `MAG_CACHE_DIR` to the Environment variables section**

Add:
```
- `MAG_CACHE_DIR` - directory for disk-cached source magazines (default: `/tmp/mag-cache/`)
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add MAG_CACHE_DIR env var"
```

---

## Task 9: Install qpdf on EC2 and deploy

**Step 1: SSH to EC2 (Amazon Linux) and install qpdf**

```bash
sudo yum install -y qpdf
qpdf --version
```

**Step 2: Create persistent cache directory (survives reboots)**

```bash
sudo mkdir -p /var/cache/mag-parser
sudo chown $(whoami):$(whoami) /var/cache/mag-parser
```

**Step 3: Update systemd service (or .env) with MAG_CACHE_DIR**

```bash
# In the .env or systemd unit:
MAG_CACHE_DIR=/var/cache/mag-parser
```

Using `/var/cache/` instead of `/tmp/` because `/tmp/` is cleared on reboot — the disk cache should survive restarts.

**Step 4: Deploy the new bundle**

```bash
npm run bundle-prod
# Deploy as usual
```

**Step 5: Verify in logs**

```bash
journalctl -u mag-parser -f
```

Expected: `qpdf available` in startup logs, disk cache hits on repeat requests.

---

## Memory Budget After Implementation

| Component | Peak RAM |
|-----------|----------|
| OS + systemd | ~150MB |
| Node process baseline | ~80MB |
| qpdf process (per request) | ~20MB |
| Extracted article in pdf-lib | ~20MB |
| Article cache (in-memory) | up to 50MB |
| **3 concurrent requests peak** | **~450MB** |
| **Headroom remaining** | **~550MB** |

Compared to current: one request could spike to 500MB+ and OOM the 1GB instance. After this refactor, three concurrent requests use less than half the RAM.
