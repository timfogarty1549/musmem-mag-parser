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

  async putFile(s3Key: string, sourcePath: string): Promise<string> {
    await this.initialize();
    const stat = await fs.stat(sourcePath);
    await this.evictToFit(stat.size);
    const filePath = this.keyToPath(s3Key);
    try {
      await fs.rename(sourcePath, filePath);
    } catch {
      // rename fails across filesystem boundaries — fall back to copy+unlink
      await fs.copyFile(sourcePath, filePath);
      await fs.unlink(sourcePath);
    }
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

  keyToPath(s3Key: string): string {
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

    if (totalSize + incomingBytes <= this.maxBytes) return;

    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const entry of entries) {
      if (totalSize + incomingBytes <= this.maxBytes) break;
      await fs.unlink(entry.path);
      totalSize -= entry.size;
      logger.debug(`Disk cache evicted: ${path.basename(entry.path)}`);
    }
  }
}
