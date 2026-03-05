import { Router, type Router as RouterType } from 'express';
import { getConnection } from '../services/solana.js';
import { getDb } from '../services/db.js';
import { getHarnessStatus } from '../harness/runner.js';
import { getFunderInfo } from '../services/fundingService.js';
import { config } from '../config.js';

export const healthRouter: RouterType = Router();

healthRouter.get('/', async (_req, res) => {
  const checks: Record<string, 'ok' | 'error'> = {};

  try {
    getDb().prepare('SELECT 1').get();
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }

  try {
    await getConnection().getSlot();
    checks.solanaRpc = 'ok';
  } catch {
    checks.solanaRpc = 'error';
  }

  const funderInfo = await getFunderInfo().catch(() => ({
    configured: false,
    publicKey: null,
    balanceSol: null,
  }));

  const allOk = Object.values(checks).every((v) => v === 'ok');
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    checks,
    harness: getHarnessStatus(),
    funder: funderInfo,
    config: {
      minAgentSol: config.MIN_AGENT_SOL,
      minActionSol: config.MIN_ACTION_SOL,
    },
    timestamp: new Date().toISOString(),
  });
});