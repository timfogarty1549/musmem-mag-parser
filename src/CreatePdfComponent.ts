import crypto from "crypto";
import path from "path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PDFDocument } from "pdf-lib";
import logger from "./services/logger";
import MagCodeService from "./services/MagCodeService";
import StatsService from "./services/StatsService";
import { MagParserPayload, parsePageRange } from "./MagParserPayload";

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

export class CreatePdfComponent {
    private readonly cache = new Map<string, Uint8Array>();
    private readonly maxCacheSize = 10;

    public async fetchArticle(payload: MagParserPayload): Promise<{ pdf: Uint8Array } | { error: string }> {
        const cacheKey = this.buildCacheKey(payload);
        const cached = this.cache.get(cacheKey);
        if (cached) {
            logger.info(`Article ${cacheKey} found in cache`);
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, cached);
            return { pdf: cached };
        }

        const mag = await this.fetchMag(payload.mag);
        if (!mag) {
            return { error: `Magazine not found in S3: ${payload.mag}` };
        }
        const newPdf = await this.createPdf(payload);
        if (!newPdf) {
            return { error: `Failed to create PDF document for: ${payload.title}` };
        }
        const pdfDoc = await this.extractArticle(newPdf, mag, parsePageRange(payload.pageRange));
        if (!pdfDoc) {
            return { error: `Failed to extract pages ${payload.pageRange} from: ${payload.mag}` };
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
        // Remove if already exists (to update position)
        if (this.cache.has(cacheKey)) {
            this.cache.delete(cacheKey);
        }

        // Evict oldest entry if cache is full
        if (this.cache.size >= this.maxCacheSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) {
                this.cache.delete(firstKey);
                logger.debug(`Cache evicted article: ${firstKey}`);
            }
        }

        // Add new entry (most recently used)
        this.cache.set(cacheKey, pdfBytes);
        logger.debug(`Article ${cacheKey} added to cache (size: ${this.cache.size}/${this.maxCacheSize})`);
    }

    /**
     * Fetch the magazine from S3
     * @param filename - The filename of the magazine to fetch from S3
     * @returns The PDF document
     */
    private async fetchMag(filename: string): Promise<PDFDocument | null> {
        // Fetch PDF from S3
        const s3 = new S3Client({
            region: process.env.AWS_REGION || 'us-east-1'
        });

        const command = new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: filename
        });

        let response;
        try {
            response = await s3.send(command);
        } catch (error: unknown) {
            const code = (error as { name?: string }).name;
            if (code === 'NoSuchKey') {
                logger.warn(`Magazine not found in S3: bucket=${process.env.S3_BUCKET_NAME}, key=${filename}`);
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