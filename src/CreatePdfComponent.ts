import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
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
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const DISK_CACHE_BYTES = 4 * 1024 * 1024 * 1024;
const S3_TIMEOUT_MS = 60_000;

type EnsureMagResult = string | null | 'too_large';

export type OnStaleCacheCallback = (s3Key: string) => void;

export class CreatePdfComponent {
    private static instance: CreatePdfComponent;
    private readonly cache = new Map<string, Uint8Array>();
    private cacheBytes = 0;
    private activeRequests = 0;
    private readonly maxActiveRequests = 2;
    private readonly s3: S3Client;
    private readonly diskCache: DiskCacheService;
    private readonly qpdf: QpdfService;
    private onStaleCallbacks: OnStaleCacheCallback[] = [];

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

    public onStaleCache(callback: OnStaleCacheCallback): void {
        this.onStaleCallbacks.push(callback);
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
        const magPath = await this.ensureMagOnDisk(payload.mag);
        if (magPath === 'too_large') {
            return { error: 'This magazine is too large to process. Please contact support.', status: 413 };
        }
        if (!magPath) {
            return { error: 'The requested article could not be retrieved.', status: 404 };
        }

        const offset = payload.offset ?? 0;
        const pages = parsePageRange(payload.pageRange).map(p => p + offset);
        const tempOutput = path.join(os.tmpdir(), `article-${cacheKey.substring(0, 12)}.pdf`);
        try {
            await this.qpdf.extractPages(magPath, pages, tempOutput);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to extract pages ${payload.pageRange} from ${payload.mag}: ${msg}`);
            return { error: 'Failed to extract the requested pages.' };
        }

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
            return { error: 'Failed to create PDF document.' };
        } finally {
            fs.unlink(tempOutput).catch(() => {});
        }
    }

    public async ensureMagOnDisk(s3Key: string): Promise<EnsureMagResult> {
        let head;
        try {
            head = await this.s3.send(new HeadObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME,
                Key: s3Key
            }));

            if (head.ContentLength && head.ContentLength > MAX_PDF_SIZE_BYTES) {
                logger.error(`Magazine "${s3Key}" exceeds size limit: ${Math.round(head.ContentLength / 1024 / 1024)}MB`);
                return 'too_large';
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

        const cachedPath = await this.diskCache.get(s3Key);
        if (cachedPath) {
            const cachedEtag = await this.diskCache.getEtag(s3Key);
            if (cachedEtag && cachedEtag === head.ETag) {
                logger.debug(`Disk cache hit (ETag match): ${s3Key}`);
                return cachedPath;
            }
            if (cachedEtag) {
                logger.info(`S3 object changed (ETag mismatch), re-downloading: ${s3Key}`);
                await this.diskCache.remove(s3Key);
                for (const cb of this.onStaleCallbacks) cb(s3Key);
            }
        }

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

            const tempPath = path.join(os.tmpdir(), `dl-${crypto.randomBytes(8).toString('hex')}.pdf`);
            const body = response.Body as Readable;
            await pipeline(body, createWriteStream(tempPath));
            const stat = await fs.stat(tempPath);
            const filePath = await this.diskCache.putFile(s3Key, tempPath, head.ETag);
            logger.info(`Magazine cached to disk: ${s3Key} (${Math.round(stat.size / 1024 / 1024)}MB)`);
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
        const raw = `${payload.mag}|${payload.pageRange}|${payload.offset ?? 0}`;
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
