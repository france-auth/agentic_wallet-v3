import express from 'express';
import 'dotenv/config';
import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { getDb } from './services/db.js';
import fs from 'fs';
import path from 'path';

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Initialize DB eagerly
getDb();

const app: express.Express = createApp();

const server = app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      rpcUrl: config.SOLANA_RPC_URL,
      corsOrigin: config.CORS_ORIGIN,
    },
    `🚀 Agentic Wallet API running on http://localhost:${config.PORT}`
  );
  logger.warn(
    '⚠️  PROTOTYPE WARNING: This is a devnet prototype. Do NOT use real funds or production keys.'
  );
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

export default app;