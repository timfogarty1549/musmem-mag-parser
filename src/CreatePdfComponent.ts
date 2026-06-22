import crypto from "crypto";
import path from "path";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PDFDocument } from "pdf-lib";
import logger from "./services/logger";
import MagCodeService from "./services/MagCodeService";
import StatsService from "./services/StatsService";
import { MagParserPayload, parsePageRange } from "./MagParserPayload";

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

const MAX_PDF_SIZE_BYTES = 200 * 1024 * 1024; // 200MB
const MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50MB total cache (tight on 1GB instance)
const S3_TIMEOUT_MS = 30_000;

export class CreatePdfComponent {
    private static instance: CreatePdfComponent;
    private readonly cache = new Map<string, Uint8Array>();
    private cacheBytes = 0;
    private activeRequests = 0;
    private readonly maxActiveRequests = 1; // 1GB instance can only safely process one large PDF at a time
    private readonly s3: S3Client;

    private constructor() {
        this.s3 = new S3Client({
            region: process.env.AWS_REGION || 'us-east-1'
        });
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
            logger.info(`Article ${cacheKey} found in cache`);
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
        const mag = await this.fetchMag(payload.mag);
        if (mag === 'too_large') {
            return { error: 'This magazine is too large to process. Please contact support.', status: 413 };
        }
        if (!mag) {
            return { error: 'The requested article could not be retrieved.', status: 404 };
        }
        const newPdf = await this.createPdf(payload);
        if (!newPdf) {
            return { error: 'Failed to create PDF document.' };
        }
        const pdfDoc = await this.extractArticle(newPdf, mag, parsePageRange(payload.pageRange));
        if (!pdfDoc) {
            return { error: `Failed to extract the requested pages.` };
        }
        const pdfBytes = await pdfDoc.save();

        this.addToCache(cacheKey, pdfBytes);

        StatsService.incrementArticles();
        return { pdf: pdfBytes };
    }

    private buildCacheKey(payload: MagParserPayload): string {
        const raw = `${payload.mag}|${payload.pageRange}`;
        return crypto.createHash('sha256').update(raw).digest('hex');
    }

    private addToCache(cacheKey: string, pdfBytes: Uint8Array): void {
        const entrySize = pdfBytes.byteLength;

        // Don't cache articles larger than half the cache limit
        if (entrySize > MAX_CACHE_BYTES / 2) {
            logger.debug(`Article ${cacheKey} too large to cache (${Math.round(entrySize / 1024 / 1024)}MB)`);
            return;
        }

        // Remove if already exists (to update position)
        if (this.cache.has(cacheKey)) {
            this.cacheBytes -= this.cache.get(cacheKey)!.byteLength;
            this.cache.delete(cacheKey);
        }

        // Evict oldest entries until we have room
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

    private async fetchMag(filename: string): Promise<PDFDocument | null | 'too_large'> {
        // Pre-flight: check key exists and size before downloading
        try {
            const head = await this.s3.send(new HeadObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME,
                Key: filename
            }));

            if (head.ContentLength && head.ContentLength > MAX_PDF_SIZE_BYTES) {
                logger.error(`Magazine "${filename}" exceeds size limit: ${Math.round(head.ContentLength / 1024 / 1024)}MB`);
                return 'too_large';
            }
        } catch (error: unknown) {
            const name = (error as { name?: string }).name;
            if (name === 'NotFound' || name === 'NoSuchKey') {
                logger.warn(`Magazine not found in S3: bucket=${process.env.S3_BUCKET_NAME}, key=${filename}`);
            } else {
                logger.error(`S3 HeadObject error for "${filename}": ${(error as Error).message ?? error}`);
            }
            return null;
        }

        const command = new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: filename
        });

        let response;
        try {
            response = await this.s3.send(command, {
                requestTimeout: S3_TIMEOUT_MS
            });
        } catch (error: unknown) {
            const name = (error as { name?: string }).name;
            if (name === 'NoSuchKey') {
                logger.warn(`Magazine not found in S3: bucket=${process.env.S3_BUCKET_NAME}, key=${filename}`);
            } else if (name === 'TimeoutError') {
                logger.error(`S3 download timed out for "${filename}" after ${S3_TIMEOUT_MS}ms`);
            } else {
                logger.error(`S3 error fetching magazine "${filename}": ${(error as Error).message ?? error}`);
            }
            return null;
        }

        if (!response.Body) {
            logger.warn(`Empty response body from S3 for: ${filename}`);
            return null;
        }

        const pdfBytes = await response.Body.transformToByteArray();

        return PDFDocument.load(pdfBytes);
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

    private async createPdf(article: MagParserPayload): Promise<PDFDocument> {
        const newDoc = await PDFDocument.create();
        newDoc.setTitle(article.title);
        newDoc.setAuthor(article.author);
        const seriesCode = path.basename(path.dirname(article.mag));
        const magName = MagCodeService.getName(seriesCode);
        if (magName) {
            newDoc.setSubject(this.buildSubject(article, magName));
        }
        newDoc.setProducer('MuscleMemory.org');
        newDoc.setCreator('Tim Fogarty');
        newDoc.setCreationDate(new Date());
        newDoc.setModificationDate(new Date());

        return newDoc;
    }

    private async extractArticle(newDoc: PDFDocument, mag: PDFDocument, pages: number[]): Promise<PDFDocument> {
        // Validate pages are within range
        const totalPages = mag.getPageCount();
        const invalidPages = pages.filter((p) => p < 1 || p > totalPages);
        if (invalidPages.length > 0) {
            logger.warn(`Invalid page numbers: ${invalidPages.join(', ')}. Total pages: ${totalPages}`);
        }

        // Convert 1-indexed page numbers to 0-indexed for pdf-lib
        const pagesToCopy = pages
            .filter((p) => p >= 1 && p <= totalPages)
            .map((p) => p - 1);

        if (pagesToCopy.length === 0) {
            logger.error('No valid pages to copy');
            return newDoc;
        }

        // copyPages preserves all page content: images, OCR text layer, annotations, etc.
        const copiedPages = await newDoc.copyPages(mag, pagesToCopy);
        copiedPages.forEach((page) => {
            newDoc.addPage(page);
        });

        return newDoc;
    }
}