import { Keypair } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import {
  decideNextAction,
  transferSol,
  transferSpl,
  jupiterSwap,
  getSolBalance,
  getSplBalance,
} from '@aws/core';
import type { ActionRecord, ActionType } from '@aws/core';
import { getConnection, sleep } from '../services/solana.js';
import { decryptSecretKey } from '../services/encryption.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getAllAgents,
  getAgentById,
  insertAction,
  updateAction,
  getActiveSplMint,
  listActions,
} from '../services/db.js';

// ─── Harness state ────────────────────────────────────────────────────────────

interface HarnessState {
  running: boolean;
  intervalMs: number;
  startedAt: string | null;
  cyclesRun: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const state: HarnessState = {
  running: false,
  intervalMs: config.HARNESS_INTERVAL_MS,
  startedAt: null,
  cyclesRun: 0,
  timer: null,
};

export function getHarnessStatus() {
  return {
    running: state.running,
    intervalMs: state.intervalMs,
    startedAt: state.startedAt,
    cyclesRun: state.cyclesRun,
  };
}

export function startHarness(intervalMs?: number): void {
  if (state.running) return;
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.intervalMs = intervalMs ?? state.intervalMs;
  logger.info({ intervalMs: state.intervalMs }, 'Harness started');
  scheduleNext();
}

export function stopHarness(): void {
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  logger.info({ cyclesRun: state.cyclesRun }, 'Harness stopped');
}

function scheduleNext(): void {
  if (!state.running) return;
  state.timer = setTimeout(async () => {
    try {
      await runAllAgentsCycle();
    } catch (err) {
      logger.error({ err }, 'Harness cycle error');
    }
    state.cyclesRun++;
    scheduleNext();
  }, state.intervalMs);
}

// ─── Single agent cycle ───────────────────────────────────────────────────────

export async function runAgentOnce(agentId: string): Promise<ActionRecord> {
  const agent = getAgentById(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const connection = getConnection();
  const secretKey = decryptSecretKey(agent.encryptedPrivateKey);

  // ── Balance guard: skip if not enough SOL ────────────────────────────────
  const solBalance = await getSolBalance(connection, agent.publicKey).catch(() => 0);

  if (solBalance < config.MIN_ACTION_SOL) {
    logger.warn(
      { agentId, solBalance, minRequired: config.MIN_ACTION_SOL },
      'Agent has insufficient funds — recording SKIPPED_INSUFFICIENT_FUNDS'
    );
    const action: ActionRecord = {
      id: uuidv4(),
      agentId,
      type: 'ACTION_SOL_TRANSFER', // placeholder type for skipped action
      status: 'SKIPPED_INSUFFICIENT_FUNDS',
      amount: null,
      mint: null,
      signature: null,
      explorerUrl: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: `Balance ${solBalance.toFixed(6)} SOL is below MIN_ACTION_SOL (${config.MIN_ACTION_SOL} SOL). Use POST /agents/${agentId}/fund to top up.`,
    };
    insertAction(action);
    return action;
  }

  // ── Fetch SPL balance and decide action ──────────────────────────────────
  const splMintInfo = getActiveSplMint();
  const splBalance = splMintInfo
    ? await getSplBalance(connection, agent.publicKey, splMintInfo.mint).catch(() => 0)
    : 0;

  const { total: cycleIndex } = listActions({ agentId });

  const actionType = decideNextAction({
    solBalance,
    splBalance,
    lastActionType: null,
    cycleIndex,
  });

  logger.info({ agentId, actionType, solBalance, splBalance }, 'Agent executing action');

  const action: ActionRecord = {
    id: uuidv4(),
    agentId,
    type: actionType,
    status: 'PENDING',
    amount: null,
    mint: null,
    signature: null,
    explorerUrl: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  insertAction(action);

  try {
    const result = await executeAction(secretKey, agent.publicKey, actionType, splMintInfo ?? null);
    updateAction(action.id, {
      status: result.status,
      signature: result.signature ?? null,
      explorerUrl: result.explorerUrl ?? null,
      amount: result.amount ?? null,
      finishedAt: new Date().toISOString(),
      error: result.error ?? null,
    });
    return { ...action, ...result, finishedAt: new Date().toISOString() };
  } catch (err) {
    const error = (err as Error).message;
    updateAction(action.id, {
      status: 'FAILED',
      error,
      finishedAt: new Date().toISOString(),
    });
    logger.error({ agentId, actionType, error }, 'Action failed');
    return { ...action, status: 'FAILED', error, finishedAt: new Date().toISOString() };
  }
}

// ─── All-agents cycle ─────────────────────────────────────────────────────────

export async function runAllAgentsCycle(): Promise<ActionRecord[]> {
  const agents = getAllAgents();
  if (agents.length === 0) {
    logger.warn('No agents found, skipping cycle');
    return [];
  }
  logger.info({ agentCount: agents.length }, 'Running cycle for all agents');

  const results: ActionRecord[] = [];
  for (const agent of agents) {
    try {
      const result = await runAgentOnce(agent.id);
      results.push(result);
      await sleep(500);
    } catch (err) {
      // Never crash the whole harness due to a single agent error
      logger.error({ agentId: agent.id, err }, 'Agent cycle error — continuing with next agent');
    }
  }
  return results;
}

// ─── Action executor ──────────────────────────────────────────────────────────

interface ActionResult {
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED_NO_ROUTE' | 'SKIPPED_INSUFFICIENT_FUNDS';
  signature?: string;
  explorerUrl?: string;
  amount?: number;
  error?: string;
}

async function executeAction(
  secretKey: Uint8Array,
  agentPublicKey: string,
  type: ActionType,
  splMint: { mint: string; decimals: number } | null
): Promise<ActionResult> {
  const connection = getConnection();

  switch (type) {
    case 'ACTION_SOL_TRANSFER': {
      const lamports = 1000; // 0.000001 SOL
      const result = await transferSol(connection, {
        fromSecretKey: secretKey,
        toPublicKey: config.RECEIVER_PUBLIC_KEY,
        lamports,
      });
      return {
        status: 'SUCCESS',
        signature: result.signature,
        explorerUrl: result.explorerUrl,
        amount: lamports,
      };
    }

    case 'ACTION_SPL_TRANSFER': {
      if (!splMint) {
        return { status: 'SKIPPED_NO_ROUTE', error: 'No SPL mint configured' };
      }
      const amount = BigInt(1);
      const result = await transferSpl(connection, {
        fromSecretKey: secretKey,
        toPublicKey: config.RECEIVER_PUBLIC_KEY,
        mint: splMint.mint,
        amount,
        decimals: splMint.decimals,
      });
      return {
        status: 'SUCCESS',
        signature: result.signature,
        explorerUrl: result.explorerUrl,
        amount: Number(amount),
      };
    }

    case 'ACTION_JUPITER_SWAP': {
      const swapResult = await jupiterSwap(connection, {
        agentSecretKey: secretKey,
        inputMint: config.JUPITER_INPUT_MINT,
        outputMint: config.JUPITER_OUTPUT_MINT,
        amountLamports: config.JUPITER_SWAP_AMOUNT_LAMPORTS,
        slippageBps: config.JUPITER_SLIPPAGE_BPS,
      });

      if (!swapResult.ok) {
        if (swapResult.reason === 'NO_ROUTE') {
          logger.warn({ agentPublicKey }, 'Jupiter: no route, skipping');
          return { status: 'SKIPPED_NO_ROUTE', error: swapResult.message };
        }
        return { status: 'FAILED', error: swapResult.message };
      }

      return {
        status: 'SUCCESS',
        signature: swapResult.signature,
        explorerUrl: swapResult.explorerUrl,
        amount: config.JUPITER_SWAP_AMOUNT_LAMPORTS,
      };
    }

    default:
      return { status: 'FAILED', error: `Unknown action type: ${type}` };
  }
}