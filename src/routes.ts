import express from 'express';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import logger from './services/logger';
import StatsService from './services/StatsService';
import { Helper } from './utils/helper';
import { CreatePdfComponent } from './CreatePdfComponent';
import { isValidPayload, isValidPageViewerPayload, MagParserPayload, PageViewerPayload } from './MagParserPayload';
import { PageImageComponent } from './PageImageComponent';

const router = express.Router();

const REQUEST_TIMEOUT_MS = 55_000; // Respond before typical 60s gateway timeout

export { router };

router.get('/stats', (_req: express.Request, res: express.Response) => {
  res.json(StatsService.getStats());
});

// Version route
router.get('/version', (req: express.Request, res: express.Response) => {
  try {
    const bundlePath = path.join(__dirname, '../dist/bundle.js');
    const stats = fs.statSync(bundlePath);
    const date = stats.mtime.toISOString();

    res.json({
      version: process.env.VERSION,
      date: date,
      internal: 1234
    });
  } catch (error: unknown) {
    res.json({
      version: process.env.VERSION,
      date: null
    });
  }
});

router.get('/', async (req: express.Request, res: express.Response) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      logger.error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms for mag: ${(req.query.token as string)?.substring(0, 20)}...`);
      res.status(504).json({ error: 'Request timed out' });
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    const token = req.query.token ?? '';
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing token' });
    }

    const secret = process.env.MAG_PARSER_SECRET;
    if (!secret) {
      logger.error('MAG_PARSER_SECRET is not configured');
      return res.status(500).json({ error: 'Failed to parse PDF', details: 'Server misconfiguration' });
    }

    let payload: MagParserPayload;
    try {
      const decoded = jwt.verify(token, secret);
      if (!isValidPayload(decoded)) {
        return res.status(401).json({ error: 'Invalid token payload' });
      }
      payload = decoded;
    } catch (error: unknown) {
      logger.warn(`JWT verification failed: ${Helper.getErrorMessage(error)}`);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const result = await CreatePdfComponent.getInstance().fetchArticle(payload);
    if (res.headersSent) return;

    if ('error' in result) {
      const status = result.status || 400;
      logger.warn(`Failed to fetch article (${status}): ${result.error}`);
      return res.status(status).json({ error: 'Failed to fetch article', details: result.error });
    }
    const magId = path.basename(payload.mag, '.pdf');
    const filename = `${magId}_${payload.title}`.replace(/ /g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(Buffer.from(result.pdf));

  } catch (error: unknown) {
    if (res.headersSent) return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to parse PDF: ${errorMessage}`, error);
    res.status(500).json({ error: 'Failed to parse PDF', details: errorMessage });
  } finally {
    clearTimeout(timeout);
  }
});

function verifyPageViewerToken(req: express.Request, res: express.Response): PageViewerPayload | null {
  const token = req.query.token;
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Missing token' });
    return null;
  }

  const secret = process.env.MAG_PARSER_SECRET;
  if (!secret) {
    logger.error('MAG_PARSER_SECRET is not configured');
    res.status(500).json({ error: 'Server misconfiguration' });
    return null;
  }

  try {
    const decoded = jwt.verify(token, secret);
    if (!isValidPageViewerPayload(decoded)) {
      res.status(401).json({ error: 'Invalid token payload' });
      return null;
    }
    return decoded;
  } catch (error: unknown) {
    logger.warn(`JWT verification failed: ${Helper.getErrorMessage(error)}`);
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
}

router.get('/page/info', async (req: express.Request, res: express.Response) => {
  const payload = verifyPageViewerToken(req, res);
  if (!payload) return;

  try {
    const result = await PageImageComponent.getInstance().getPageCount(payload.mag);
    if ('error' in result) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ totalPages: result.totalPages });
  } catch (error: unknown) {
    logger.error(`Page info failed: ${Helper.getErrorMessage(error)}`);
    res.status(500).json({ error: 'Failed to get page info' });
  }
});

router.get('/page', async (req: express.Request, res: express.Response) => {
  const payload = verifyPageViewerToken(req, res);
  if (!payload) return;

  const page = parseInt(req.query.page as string, 10);
  if (isNaN(page) || page < 1 || page > payload.totalPages) {
    return res.status(400).json({ error: `Invalid page number. Must be 1-${payload.totalPages}` });
  }

  try {
    const result = await PageImageComponent.getInstance().getPageImage(payload.mag, page);
    if ('error' in result) {
      return res.status(result.status).json({ error: result.error });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.sendFile(result.path);
  } catch (error: unknown) {
    logger.error(`Page render failed: ${Helper.getErrorMessage(error)}`);
    res.status(500).json({ error: 'Failed to render page' });
  }
});