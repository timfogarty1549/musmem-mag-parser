import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs/promises';
import logger from './services/logger';
import StatsService from './services/StatsService';
import { CreatePdfComponent } from './CreatePdfComponent';
import { QpdfService } from './services/QpdfService';
import { PopplerService } from './services/PopplerService';
import { PageImageCacheService } from './services/PageImageCacheService';

const PAGE_CACHE_BYTES = 6 * 1024 * 1024 * 1024;

export class PageImageComponent {
  private static instance: PageImageComponent;
  private activeRenders = 0;
  private readonly maxActiveRenders = 2;
  private readonly pageCache: PageImageCacheService;
  private readonly qpdf: QpdfService;
  private readonly poppler: PopplerService;

  private constructor() {
    const pageCacheDir = process.env.MAG_PAGE_CACHE_DIR || path.join(os.tmpdir(), 'mag-pages');
    this.pageCache = new PageImageCacheService(pageCacheDir, PAGE_CACHE_BYTES);
    this.qpdf = new QpdfService();
    this.poppler = new PopplerService();

    CreatePdfComponent.getInstance().onStaleCache((s3Key) => {
      this.pageCache.purge(s3Key);
    });
  }

  public static getInstance(): PageImageComponent {
    if (!PageImageComponent.instance) {
      PageImageComponent.instance = new PageImageComponent();
    }
    return PageImageComponent.instance;
  }

  public async getPageImage(s3Key: string, page: number): Promise<{ path: string } | { error: string; status: number }> {
    const cached = await this.pageCache.getPageImage(s3Key, page);
    if (cached) {
      logger.debug(`Page cache hit: ${s3Key} page ${page}`);
      return { path: cached };
    }

    if (this.activeRenders >= this.maxActiveRenders) {
      logger.warn(`Rejecting page render: ${this.activeRenders} concurrent renders in progress`);
      return { error: 'Server busy, please retry shortly', status: 503 };
    }

    this.activeRenders++;
    try {
      return await this.renderPage(s3Key, page);
    } finally {
      this.activeRenders--;
    }
  }

  public async getPageCount(s3Key: string): Promise<{ totalPages: number } | { error: string; status: number }> {
    const cached = await this.pageCache.getPageCount(s3Key);
    if (cached) return { totalPages: cached };

    const magPath = await CreatePdfComponent.getInstance().ensureMagOnDisk(s3Key);
    if (magPath === 'too_large') return { error: 'Magazine too large to process', status: 413 };
    if (!magPath) return { error: 'Magazine not found', status: 404 };

    const count = await this.poppler.getPageCount(magPath);
    await this.pageCache.putPageCount(s3Key, count);
    return { totalPages: count };
  }

  private async renderPage(s3Key: string, page: number): Promise<{ path: string } | { error: string; status: number }> {
    const magPath = await CreatePdfComponent.getInstance().ensureMagOnDisk(s3Key);
    if (magPath === 'too_large') return { error: 'Magazine too large to process', status: 413 };
    if (!magPath) return { error: 'Magazine not found', status: 404 };

    const tempId = crypto.randomBytes(8).toString('hex');
    const tempPagePdf = path.join(os.tmpdir(), `page-extract-${tempId}.pdf`);
    const tempImagePrefix = path.join(os.tmpdir(), `page-render-${tempId}`);

    try {
      await this.qpdf.extractPages(magPath, [page], tempPagePdf);
      const jpegPath = await this.poppler.renderPageToJpeg(tempPagePdf, 1, tempImagePrefix);
      const cachedPath = await this.pageCache.putPageImage(s3Key, page, jpegPath);
      StatsService.incrementPages();
      return { path: cachedPath };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to render page ${page} of ${s3Key}: ${msg}`);
      return { error: 'Failed to render page', status: 500 };
    } finally {
      fs.unlink(tempPagePdf).catch(() => {});
      fs.unlink(`${tempImagePrefix}.jpg`).catch(() => {});
    }
  }
}
