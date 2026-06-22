import { QpdfService } from './QpdfService';

describe('QpdfService', () => {
  describe('buildPageArg', () => {
    it('converts page numbers array to qpdf page argument', () => {
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
