import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { agentsRouter } from './routes/agents.js';
import { harnessRouter } from './routes/harness.js';
import { actionsRouter } from './routes/actions.js';
import { healthRouter } from './routes/health.js';
import { logger } from './logger.js';

export function createApp(): express.Express {
  const app = express();

  // ── Security headers ────────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS ────────────────────────────────────────────────────────────────────
  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'x-api-key'],
    })
  );

  // ── Body parsing with size limits ───────────────────────────────────────────
  app.use(express.json({ limit: '50kb' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  // ── Request logging ─────────────────────────────────────────────────────────
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, path: req.path }, 'Incoming request');
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/agents', agentsRouter);
  app.use('/harness', harnessRouter);
  app.use('/actions', actionsRouter);

  // ── 404 ─────────────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ── Global error handler ─────────────────────────────────────────────────────
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}