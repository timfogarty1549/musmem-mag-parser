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

  it('moves an existing file into cache via putFile', async () => {
    const tmpFile = path.join(os.tmpdir(), 'test-move.pdf');
    await fs.writeFile(tmpFile, Buffer.from('moved content'));
    const result = await service.putFile('moved.pdf', tmpFile);
    const content = await fs.readFile(result);
    expect(content.toString()).toBe('moved content');
    await expect(fs.access(tmpFile)).rejects.toThrow();
  });

  it('converts S3 key to safe filename', async () => {
    const data = Buffer.from('content');
    await service.put('series/subdir/magazine.pdf', data);
    const result = await service.get('series/subdir/magazine.pdf');
    expect(result).not.toBeNull();
    const filename = path.basename(result!);
    expect(filename).not.toContain('/');
  });
});
