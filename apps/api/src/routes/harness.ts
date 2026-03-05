import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { HarnessStartSchema } from '../validators.js';
import { apiKeyAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimiter.js';
import {
  startHarness,
  stopHarness,
  getHarnessStatus,
  runAllAgentsCycle,
} from '../harness/runner.js';
import { logger } from '../logger.js';

export const harnessRouter: RouterType = Router();

// GET /harness/status
harnessRouter.get('/status', (_req, res) => {
  res.json({ status: getHarnessStatus() });
});

// POST /harness/start
harnessRouter.post('/start', apiKeyAuth, writeLimiter, (req: Request, res: Response) => {
  const parsed = HarnessStartSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    return;
  }
  startHarness(parsed.data.intervalMs);
  res.json({ status: getHarnessStatus() });
});

// POST /harness/stop
harnessRouter.post('/stop', apiKeyAuth, writeLimiter, (_req, res) => {
  stopHarness();
  res.json({ status: getHarnessStatus() });
});

// POST /harness/run-once — run 1 cycle for all agents (synchronous, returns results)
harnessRouter.post('/run-once', apiKeyAuth, writeLimiter, async (_req, res: Response) => {
  try {
    const results = await runAllAgentsCycle();
    res.json({ actions: results, count: results.length });
  } catch (err) {
    logger.error({ err }, 'Harness run-once error');
    res.status(500).json({ error: (err as Error).message });
  }
});