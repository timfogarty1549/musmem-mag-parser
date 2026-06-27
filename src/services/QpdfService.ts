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
      // qpdf exit code 3 = succeeded with warnings; output file is valid
      if ((error as NodeJS.ErrnoException & { code?: number }).code === 3) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`qpdf completed with warnings for ${inputPath}: ${msg}`);
        return;
      }
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
