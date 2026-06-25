import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import logger from './logger';

export class PageImageCacheService {
  private readonly cacheDir: string;
  private readonly maxBytes: number;

  constructor(cacheDir: string, maxBytes: number) {
    this.cacheDir = cacheDir;
    this.maxBytes = maxBytes;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async getPageImage(s3Key: string, page: number): Promise<string | null> {
    const filePath = this.pagePath(s3Key, page);
    try {
      await fs.access(filePath);
      const now = new Date();
      await fs.utimes(filePath, now, now);
      return filePath;
    } catch {
      return null;
    }
  }

  async putPageImage(s3Key: string, page: number, sourcePath: string): Promise<string> {
    const dir = this.magDir(s3Key);
    await fs.mkdir(dir, { recursive: true });
    const filePath = this.pagePath(s3Key, page);
    await this.evictToFit(sourcePath);
    try {
      await fs.rename(sourcePath, filePath);
    } catch {
      await fs.copyFile(sourcePath, filePath);
      await fs.unlink(sourcePath);
    }
    return filePath;
  }

  async getPageCount(s3Key: string): Promise<number | null> {
    const metaPath = path.join(this.magDir(s3Key), '.meta');
    try {
      const data = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(data).totalPages ?? null;
    } catch {
      return null;
    }
  }

  async putPageCount(s3Key: string, count: number): Promise<void> {
    const dir = this.magDir(s3Key);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.meta'), JSON.stringify({ totalPages: count }));
  }

  async purge(s3Key: string): Promise<void> {
    const dir = this.magDir(s3Key);
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        await fs.unlink(path.join(dir, file)).catch(() => {});
      }
      await fs.rmdir(dir).catch(() => {});
      logger.info(`Purged page cache for: ${s3Key}`);
    } catch {
      // directory doesn't exist — nothing to purge
    }
  }

  private magDir(s3Key: string): string {
    const hash = crypto.createHash('sha256').update(s3Key).digest('hex').substring(0, 12);
    return path.join(this.cacheDir, hash);
  }

  private pagePath(s3Key: string, page: number): string {
    return path.join(this.magDir(s3Key), `page-${page}.jpg`);
  }

  private async evictToFit(sourcePath: string): Promise<void> {
    const stat = await fs.stat(sourcePath);
    const incomingBytes = stat.size;

    let totalSize = 0;
    const entries: { path: string; size: number; mtimeMs: number }[] = [];

    let dirs: string[];
    try {
      dirs = await fs.readdir(this.cacheDir);
    } catch {
      return;
    }

    for (const dir of dirs) {
      const dirPath = path.join(this.cacheDir, dir);
      const dirStat = await fs.stat(dirPath).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      const files = await fs.readdir(dirPath).catch(() => [] as string[]);
      for (const file of files) {
        if (file === '.meta') continue;
        const filePath = path.join(dirPath, file);
        const fileStat = await fs.stat(filePath).catch(() => null);
        if (!fileStat) continue;
        entries.push({ path: filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
        totalSize += fileStat.size;
      }
    }

    if (totalSize + incomingBytes <= this.maxBytes) return;

    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of entries) {
      if (totalSize + incomingBytes <= this.maxBytes) break;
      await fs.unlink(entry.path);
      totalSize -= entry.size;
      logger.debug(`Page cache evicted: ${entry.path}`);
    }
  }
}
