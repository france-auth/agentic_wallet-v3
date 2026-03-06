import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getMint,
} from '@solana/spl-token';
import type { TransferSolParams, TransferSplParams, WalletOpResult } from '../types.js';

const EXPLORER_BASE = 'https://explorer.solana.com/tx';

function explorerUrl(sig: string, cluster: string = 'devnet'): string {
  return `${EXPLORER_BASE}/${sig}?cluster=${cluster}`;
}

// ─── SOL Transfer ────────────────────────────────────────────────────────────

export async function transferSol(
  connection: Connection,
  params: TransferSolParams
): Promise<WalletOpResult> {
  const fromKeypair = Keypair.fromSecretKey(params.fromSecretKey);
  const toPublicKey = new PublicKey(params.toPublicKey);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports: params.lamports,
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair], {
    commitment: 'confirmed',
    maxRetries: 3,
  });

  return { signature, explorerUrl: explorerUrl(signature) };
}

// ─── SPL Token Transfer ──────────────────────────────────────────────────────

export async function transferSpl(
  connection: Connection,
  params: TransferSplParams
): Promise<WalletOpResult> {
  const fromKeypair = Keypair.fromSecretKey(params.fromSecretKey);
  const mintPubkey = new PublicKey(params.mint);
  const toPubkey = new PublicKey(params.toPublicKey);

  // Get or create source ATA
  const sourceAta = await getOrCreateAssociatedTokenAccount(
    connection,
    fromKeypair,
    mintPubkey,
    fromKeypair.publicKey
  );

  // Get or create destination ATA
  const destAta = await getOrCreateAssociatedTokenAccount(
    connection,
    fromKeypair, // payer
    mintPubkey,
    toPubkey
  );

  const transaction = new Transaction().add(
    createTransferInstruction(
      sourceAta.address,
      destAta.address,
      fromKeypair.publicKey,
      params.amount
    )
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair], {
    commitment: 'confirmed',
    maxRetries: 3,
  });

  return { signature, explorerUrl: explorerUrl(signature) };
}

// ─── Jupiter Swap ────────────────────────────────────────────────────────────

export interface JupiterSwapOptions {
  agentSecretKey: Uint8Array;
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
  jupiterApiBase?: string;
}

export type SwapResult =
  | { ok: true; signature: string; explorerUrl: string }
  | { ok: false; reason: 'NO_ROUTE' | 'SWAP_FAILED'; message: string };

export async function jupiterSwap(
  connection: Connection,
  opts: JupiterSwapOptions
): Promise<SwapResult> {
  const base = opts.jupiterApiBase ?? 'https://quote-api.jup.ag/v6';
  const agentKeypair = Keypair.fromSecretKey(opts.agentSecretKey);

  // 1. Get quote
  const quoteUrl =
    `${base}/quote?inputMint=${opts.inputMint}&outputMint=${opts.outputMint}` +
    `&amount=${opts.amountLamports}&slippageBps=${opts.slippageBps}&onlyDirectRoutes=false`;

  let quoteResp: any;
  try {
    quoteResp = await fetch(quoteUrl, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { ok: false, reason: 'SWAP_FAILED', message: `Jupiter quote fetch failed: ${err}` };
  }

  if (!quoteResp.ok) {
    const body = await quoteResp.text().catch(() => '');
    if (quoteResp.status === 400 || body.includes('COULD_NOT_FIND_ANY_ROUTE')) {
      return { ok: false, reason: 'NO_ROUTE', message: 'Jupiter: no route available for this pair' };
    }
    return {
      ok: false,
      reason: 'SWAP_FAILED',
      message: `Jupiter quote error ${quoteResp.status}: ${body.slice(0, 200)}`,
    };
  }

  const quoteData = await quoteResp.json() as { outAmount?: string; [key: string]: unknown };
  if (!quoteData || !quoteData.outAmount) {
    return { ok: false, reason: 'NO_ROUTE', message: 'Jupiter quote returned no output amount' };
  }

  // 2. Get swap transaction
  let swapResp: any;
  try {
    swapResp = await fetch(`${base}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: agentKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, reason: 'SWAP_FAILED', message: `Jupiter swap fetch failed: ${err}` };
  }

  if (!swapResp.ok) {
    const body = await swapResp.text().catch(() => '');
    return {
      ok: false,
      reason: 'SWAP_FAILED',
      message: `Jupiter swap error ${swapResp.status}: ${body.slice(0, 200)}`,
    };
  }

  const swapData = await swapResp.json() as { swapTransaction?: string; [key: string]: unknown };
  if (!swapData?.swapTransaction) {
    return { ok: false, reason: 'SWAP_FAILED', message: 'Jupiter swap: no transaction returned' };
  }

  // 3. Deserialize, sign, send
  try {
    const txBuf = Buffer.from(swapData.swapTransaction as string, 'base64');
    const versionedTx = VersionedTransaction.deserialize(txBuf);
    versionedTx.sign([agentKeypair]);

    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const rawTx = versionedTx.serialize();

    const signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    await connection.confirmTransaction(
      { signature, ...latestBlockhash },
      'confirmed'
    );

    return { ok: true, signature, explorerUrl: explorerUrl(signature) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Detect route / liquidity errors
    if (
      msg.includes('SlippageToleranceExceeded') ||
      msg.includes('liquidity') ||
      msg.includes('route')
    ) {
      return { ok: false, reason: 'NO_ROUTE', message: msg };
    }
    return { ok: false, reason: 'SWAP_FAILED', message: msg };
  }
}

// ─── Balance helpers ─────────────────────────────────────────────────────────

export async function getSolBalance(connection: Connection, publicKey: string): Promise<number> {
  const lamports = await connection.getBalance(new PublicKey(publicKey));
  return lamports / LAMPORTS_PER_SOL;
}

export async function getSplBalance(
  connection: Connection,
  ownerPublicKey: string,
  mint: string
): Promise<number> {
  try {
    const owner = new PublicKey(ownerPublicKey);
    const mintPub = new PublicKey(mint);
    const accounts = await connection.getTokenAccountsByOwner(owner, { mint: mintPub });
    if (accounts.value.length === 0) return 0;
    const info = await connection.getTokenAccountBalance(accounts.value[0].pubkey);
    return Number(info.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}
