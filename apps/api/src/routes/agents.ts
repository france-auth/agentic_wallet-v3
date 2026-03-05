import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { Keypair } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import type { AgentRecord, AgentWithBalances } from '@aws/core';
import { getSolBalance, getSplBalance } from '@aws/core';
import { CreateAgentsSchema, FundAgentSchema, FundAllSchema } from '../validators.js';
import { apiKeyAuth } from '../middleware/auth.js';
import { writeLimiter, readLimiter } from '../middleware/rateLimiter.js';
import {
  insertAgent,
  getAllAgents,
  getAgentById,
  getActiveSplMint,
  getLastActionForAgent,
  upsertSplMint,
} from '../services/db.js';
import { createSplMint, mintTokensToAgent, getConnection } from '../services/solana.js';
import { encryptSecretKey } from '../services/encryption.js';
import { ensureAgentFunded, fundAgent, fundAllAgents, getFunderInfo } from '../services/fundingService.js';
import { hasFunder } from '../services/funder.js';
import { runAgentOnce } from '../harness/runner.js';
import { logger } from '../logger.js';

export const agentsRouter: RouterType = Router();

// ─── GET /agents ─────────────────────────────────────────────────────────────

agentsRouter.get('/', readLimiter, async (_req: Request, res: Response) => {
  try {
    const agents = getAllAgents();
    const connection = getConnection();
    const splMint = getActiveSplMint();

    const withBalances: AgentWithBalances[] = await Promise.all(
      agents.map(async (a) => {
        const [solBalance, splBalance] = await Promise.all([
          getSolBalance(connection, a.publicKey).catch(() => 0),
          splMint
            ? getSplBalance(connection, a.publicKey, splMint.mint).catch(() => 0)
            : Promise.resolve(0),
        ]);
        const lastAction = getLastActionForAgent(a.id);
        return {
          ...a,
          solBalance,
          splBalance,
          splMint: splMint?.mint ?? null,
          lastActionStatus: lastAction?.status ?? null,
          lastActionAt: lastAction?.startedAt ?? null,
          fundingStatus: (a.fundingStatus ?? 'PENDING') as AgentWithBalances['fundingStatus'],
        };
      })
    );

    res.json({ agents: withBalances, count: withBalances.length });
  } catch (err) {
    logger.error({ err }, 'GET /agents error');
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// ─── GET /agents/funder-info ─────────────────────────────────────────────────

agentsRouter.get('/funder-info', readLimiter, async (_req: Request, res: Response) => {
  try {
    const info = await getFunderInfo();
    res.json({ funder: info });
  } catch (err) {
    logger.error({ err }, 'GET /agents/funder-info error');
    res.status(500).json({ error: 'Failed to get funder info' });
  }
});

// ─── GET /agents/:id ─────────────────────────────────────────────────────────

agentsRouter.get('/:id', readLimiter, async (req: Request, res: Response) => {
  try {
    const agent = getAgentById(req.params["id"] as string);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const connection = getConnection();
    const splMint = getActiveSplMint();
    const [solBalance, splBalance] = await Promise.all([
      getSolBalance(connection, agent.publicKey).catch(() => 0),
      splMint
        ? getSplBalance(connection, agent.publicKey, splMint.mint).catch(() => 0)
        : Promise.resolve(0),
    ]);
    const lastAction = getLastActionForAgent(agent.id);
    const withBalances: AgentWithBalances = {
      ...agent,
      solBalance,
      splBalance,
      splMint: splMint?.mint ?? null,
      lastActionStatus: lastAction?.status ?? null,
      lastActionAt: lastAction?.startedAt ?? null,
      fundingStatus: (agent.fundingStatus ?? 'PENDING') as AgentWithBalances['fundingStatus'],
    };
    res.json({ agent: withBalances });
  } catch (err) {
    logger.error({ err }, 'GET /agents/:id error');
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

// ─── POST /agents/create ─────────────────────────────────────────────────────

agentsRouter.post('/create', apiKeyAuth, writeLimiter, async (req: Request, res: Response) => {
  const parsed = CreateAgentsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    return;
  }
  const { count, fundSol, mintTokens } = parsed.data;

  try {
    let splMint = getActiveSplMint();
    const mintAuthority = Keypair.generate();
    const created: (AgentRecord & { fundingStatus: string })[] = [];
    const fundingResults: Record<string, { ok: boolean; method: string; error?: string }> = {};

    for (let i = 0; i < count; i++) {
      const keypair = Keypair.generate();
      const agentId = uuidv4();
      const name = `Agent-${agentId.slice(0, 8)}`;

      const agent = {
        id: agentId,
        name,
        publicKey: keypair.publicKey.toBase58(),
        encryptedPrivateKey: encryptSecretKey(keypair.secretKey),
        createdAt: new Date().toISOString(),
        fundingStatus: 'PENDING' as const,
      };

      insertAgent(agent);
      created.push(agent);
      logger.info({ agentId, publicKey: agent.publicKey }, 'Agent created');

      // Fund agent — use funder wallet if available, else airdrop, else mark NEEDS_FUNDING
      if (fundSol > 0) {
        const fundResult = await ensureAgentFunded(agentId, agent.publicKey, fundSol);
        fundingResults[agentId] = {
          ok: fundResult.ok,
          method: (fundResult as any).method ?? 'none',
          error: fundResult.ok ? undefined : (fundResult as any).reason,
        };
      }
    }

    // Create SPL mint if needed and mint to each agent
    if (mintTokens && created.length > 0) {
      // Fund the ephemeral mint authority — use funder if available
      try {
        if (hasFunder()) {
          const { transferFromFunder } = await import('../services/funder.js');
          const connection = getConnection();
          await transferFromFunder(connection, mintAuthority.publicKey.toBase58(), 0.05);
        } else {
          const { airdropSolWithRetry } = await import('../services/solana.js');
          await airdropSolWithRetry(mintAuthority.publicKey.toBase58(), 0.1);
        }
      } catch {
        logger.warn('Could not fund mint authority; SPL minting may fail');
      }

      if (!splMint) {
        try {
          const { mint } = await createSplMint(mintAuthority, 6);
          upsertSplMint(mint, 6);
          splMint = { mint, decimals: 6 };
          logger.info({ mint }, 'SPL mint created and stored');
        } catch (err) {
          logger.error({ err }, 'SPL mint creation failed');
        }
      }

      if (splMint) {
        for (const agent of created) {
          try {
            await mintTokensToAgent(
              mintAuthority,
              splMint.mint,
              agent.publicKey,
              BigInt(1_000_000) // 1 token with 6 decimals
            );
          } catch (err) {
            logger.warn({ agentId: agent.id, err: (err as Error).message }, 'Token minting failed');
          }
        }
      }
    }

    res.status(201).json({
      created: created.map((a) => ({
        id: a.id,
        name: a.name,
        publicKey: a.publicKey,
        fundingStatus: a.fundingStatus,
      })),
      count: created.length,
      splMint: splMint?.mint ?? null,
      fundingResults,
      funderUsed: hasFunder(),
    });
  } catch (err) {
    logger.error({ err }, 'POST /agents/create error');
    res.status(500).json({ error: 'Failed to create agents' });
  }
});

// ─── POST /agents/:id/fund ────────────────────────────────────────────────────

agentsRouter.post('/:id/fund', apiKeyAuth, writeLimiter, async (req: Request, res: Response) => {
  const agent = getAgentById(req.params["id"] as string);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  const parsed = FundAgentSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    return;
  }

  try {
    const result = await fundAgent(req.params["id"] as string, parsed.data.amountSol);
    if (result.ok) {
      res.json({
        success: true,
        agentId: req.params["id"] as string,
        publicKey: agent.publicKey,
        solAmount: result.solAmount,
        method: result.method,
        signature: result.signature,
        explorerUrl: result.signature
          ? `https://explorer.solana.com/tx/${result.signature}?cluster=devnet`
          : null,
      });
    } else {
      res.status(502).json({
        success: false,
        agentId: req.params["id"] as string,
        method: result.method,
        error: result.reason,
      });
    }
  } catch (err) {
    logger.error({ agentId: req.params["id"] as string, err }, 'POST /agents/:id/fund error');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── POST /agents/fund-all ────────────────────────────────────────────────────

agentsRouter.post('/fund-all', apiKeyAuth, writeLimiter, async (req: Request, res: Response) => {
  const parsed = FundAllSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    return;
  }

  try {
    const summary = await fundAllAgents(parsed.data.amountSol);
    res.json({
      ...summary,
      funderUsed: hasFunder(),
    });
  } catch (err) {
    logger.error({ err }, 'POST /agents/fund-all error');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── POST /agents/:id/run-once ────────────────────────────────────────────────

agentsRouter.post('/:id/run-once', apiKeyAuth, writeLimiter, async (req: Request, res: Response) => {
  const agent = getAgentById(req.params["id"] as string);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  try {
    const action = await runAgentOnce(req.params["id"] as string);
    res.json({ action });
  } catch (err) {
    logger.error({ agentId: req.params["id"] as string, err }, 'run-once error');
    res.status(500).json({ error: (err as Error).message });
  }
});