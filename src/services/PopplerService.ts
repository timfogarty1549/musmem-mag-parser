import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from './logger';

const execFileAsync = promisify(execFile);

const POPPLER_TIMEOUT_MS = 30_000;

export class PopplerService {
  async renderPageToJpeg(pdfPath: string, pageNum: number, outputPrefix: string, dpi: number = 200): Promise<string> {
    try {
      await execFileAsync('pdftoppm', [
        '-jpeg', '-jpegopt', 'quality=85',
        '-singlefile',
        '-r', String(dpi),
        '-f', String(pageNum),
        '-l', String(pageNum),
        pdfPath,
        outputPrefix
      ], { timeout: POPPLER_TIMEOUT_MS });
      return `${outputPrefix}.jpg`;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`pdftoppm failed for page ${pageNum}: ${msg}`);
      throw new Error(`Page rendering failed: ${msg}`);
    }
  }

  async getPageCount(pdfPath: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync('pdfinfo', [pdfPath], { timeout: POPPLER_TIMEOUT_MS });
      const match = stdout.match(/^Pages:\s+(\d+)/m);
      if (!match) throw new Error('Could not parse page count from pdfinfo output');
      return parseInt(match[1], 10);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`pdfinfo failed: ${msg}`);
      throw new Error(`Page count failed: ${msg}`);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('pdftoppm', ['-v'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
