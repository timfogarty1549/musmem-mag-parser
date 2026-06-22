import express from 'express';
import { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import logger from './services/logger';
import MagCodeService from './services/MagCodeService';
import { router as apiRouter } from './routes';
import { Helper } from './utils/helper';

// Load environment variables
dotenv.config();

const port = process.env.PORT || 3000;

const app = express();

// Trust proxy for rate limiting to work correctly with X-Forwarded-For headers
app.set('trust proxy', 1);

// Middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", "data:", "https://s3.musclememory.net", "https://s3.musclememory.org"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "https://www.gstatic.com", "https://www.google.com"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "https:", "'unsafe-inline'"],
        connectSrc: ["'self'", "https://s3.musclememory.net", "https://s3.musclememory.org"],
        upgradeInsecureRequests: [],
      },
    },
    hidePoweredBy: true,
  })
);

const options: cors.CorsOptions = {
  origin: [
    'http://localhost:4200',  // Angular dev server
    'http://127.0.0.1:4200',  // Alternative localhost
    'https://musclememory.org',
    'https://musclememory.net',
    'https://musclememory.com'
  ],
  // origin: '*',
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true, 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  preflightContinue: true,
};

app.use(cors(options));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


const shortTermLimiter = rateLimit({
  windowMs: 10 * 1000, // 10s
  max: 30,
  handler: (req: Request, res: Response) => {
    logger.warn(`Rate limit triggered: ${req.ip}`);
    res.status(429).send('Too many requests');
  },
  // Add these options for better bot detection
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

const longTermLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 1000,
  handler: (req: Request, res: Response) => {
    logger.warn(`Rate limit triggered: ${req.ip}`);
    res.status(429).send('Too many requests per hour');
  },
  // Add these options for better bot detection
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

// Apply short-term and long-term limiters only to PDF routes
app.use('/pdf', shortTermLimiter);
app.use('/pdf', longTermLimiter);


app.use('/pdf', apiRouter);


// Error handling middleware
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error(Helper.getErrorMessage(err));
  res.status(500).send('Something broke!');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise.toString()}, reason: ${Helper.getErrorMessage(reason)}`);
  // Also log the stack trace if available
  if (reason instanceof Error) {
    logger.error(`Stack trace: ${reason.stack}`);
  }
  process.exit(1);
});

process.on('uncaughtException', (error: unknown) => {
  logger.error(`Uncaught Exception: ${Helper.getErrorMessage(error)}`);
  process.exit(1);
});

MagCodeService.initialize();

// Periodic memory monitoring — warn before OOM
const MEMORY_CHECK_INTERVAL_MS = 30_000;
const MEMORY_WARN_THRESHOLD_MB = 400;
setInterval(() => {
  const memUsage = process.memoryUsage();
  const rssMB = Math.round(memUsage.rss / 1024 / 1024);
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  if (rssMB > MEMORY_WARN_THRESHOLD_MB) {
    logger.warn(`High memory usage: ${heapMB}MB heap, ${rssMB}MB RSS`);
  }
}, MEMORY_CHECK_INTERVAL_MS).unref();

// Start server only after data is loaded
const server = app.listen(port, () => {
  logger.info(`MuscleMemory Magazine Parser v${process.env.VERSION}`);
  logger.info(`Server is running on port ${port}`);
  const memUsage = process.memoryUsage();
  logger.info(`Memory usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap, ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS`);
});

server.on('error', (err: unknown) => {
  logger.error(`Server failed to start: ${Helper.getErrorMessage(err)}`);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});
