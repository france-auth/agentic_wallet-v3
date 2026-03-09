# SKILLS.md — Agentic Wallet Sandbox

> This file is written for AI coding agents and autonomous systems working in this repository. It describes what this system can do, how to interact with it programmatically, where all logic lives, and how to extend it safely.

---

## What This System Is

This is a **multi-agent autonomous wallet system** on Solana devnet. It manages multiple AI agent wallets, each capable of:

- Holding SOL and SPL tokens
- Signing and broadcasting Solana transactions without human input
- Executing SOL transfers, SPL token transfers, and Jupiter DEX swaps
- Making autonomous decisions about which action to execute next

Each agent is an independent entity with its own encrypted keypair, balance state, and action history.

---

## System Capabilities (What You Can Do)

### Agent Management
| Action | HTTP Call |
|---|---|
| Create N new agents (wallets funded with SOL + SPL) | `POST /agents/create` `{"count": N}` |
| List all agents with current balances | `GET /agents` |
| Get a single agent's detail | `GET /agents/:id` |
| Fund a specific agent | `POST /agents/:id/fund` `{"amountSol": 0.1}` |
| Fund all agents below threshold | `POST /agents/fund-all` `{"amountSol": 0.1}` |
| Check funder wallet status | `GET /agents/funder-info` |

### Agent Execution
| Action | HTTP Call |
|---|---|
| Run one decision + transaction cycle for one agent | `POST /agents/:id/run-once` |
| Run one cycle for ALL agents | `POST /agents/run-all-once` |
| Start the automatic loop (runs every N ms) | `POST /harness/start` `{"intervalMs": 30000}` |
| Stop the automatic loop | `POST /harness/stop` |
| Check harness status + system health | `GET /health` |

### Action History
| Action | HTTP Call |
|---|---|
| Get paginated action history | `GET /actions?limit=20&offset=0` |
| Filter by agent | `GET /actions?agentId=<id>` |
| Filter by status | `GET /actions?status=SUCCESS` |
| Filter by type | `GET /actions?type=ACTION_JUPITER_SWAP` |

All endpoints except `GET /health` require `x-api-key: <API_KEY>` header.

---

## Repository Map

```
agentic-wallet-sandbox/
├── packages/core/src/
│   ├── types.ts              ← ALL shared TypeScript types — start here
│   ├── agent/decision.ts     ← Decision logic: decideNextAction()
│   └── wallet/walletOps.ts   ← transferSol / transferSpl / jupiterSwap
│
├── apps/api/src/
│   ├── config.ts             ← Env var loading and validation (Zod)
│   ├── validators.ts         ← Request body schemas (Zod)
│   ├── harness/runner.ts     ← Agent loop: runAgentOnce / runAllAgentsCycle
│   ├── services/
│   │   ├── db.ts             ← SQLite DAO: agents, actions, spl_mints tables
│   │   ├── encryption.ts     ← AES-256-GCM encrypt / decrypt
│   │   ├── funder.ts         ← Funder wallet: fund agents from a hot wallet
│   │   └── solana.ts         ← Connection, airdrop, mint helpers
│   └── routes/               ← Express route handlers
│
└── apps/web/src/app/
    ├── lib/api.ts             ← Typed fetch client for all API endpoints
    └── components/            ← React dashboard components
        ├── DashboardClient.tsx
        ├── ActionsClient.tsx
        ├── AgentDetailClient.tsx
        ├── BottomSheet.tsx
        └── Sidebar.tsx
```

---

## Key Data Shapes

```typescript
// packages/core/src/types.ts

interface AgentRecord {
  id: string;
  name: string;
  publicKey: string;             // base58 Solana address
  encryptedSecretKey: string;    // AES-256-GCM ciphertext — never plaintext
  solBalance: number;
  splBalance: number;
  splMint: string | null;
  lastActionStatus: ActionStatus | null;
  lastActionAt: string | null;
  createdAt: string;
}

interface ActionRecord {
  id: string;
  agentId: string;
  type: ActionType;              // 'ACTION_SOL_TRANSFER' | 'ACTION_SPL_TRANSFER' | 'ACTION_JUPITER_SWAP'
  status: ActionStatus;          // 'SUCCESS' | 'FAILED' | 'PENDING' | 'SKIPPED_NO_ROUTE' | 'SKIPPED_INSUFFICIENT_FUNDS'
  signature: string | null;      // on-chain tx signature if broadcast
  explorerUrl: string | null;    // Solana Explorer URL
  amount: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}
```

---

## How the Agent Decision Cycle Works

When `runAgentOnce(agentId)` is called:

```
1. Load agent from DB (encrypted key + balances)
2. Decrypt secret key using AGENT_MASTER_KEY (AES-256-GCM)
3. Reconstruct Keypair from decrypted bytes
4. Call decideNextAction(context) → ActionType
5. Call executeAction(connection, agent, keypair, actionType)
6. Sign + broadcast transaction to Solana devnet
7. Write ActionRecord to DB (signature, status, amount)
8. Update agent balances in DB
9. Return ActionRecord to caller
```

The plaintext private key exists only within step 2–6 of this call. It is never stored, logged, or passed outside the runner.

---

## How to Add a New Action Type

### Step 1 — Add to `packages/core/src/types.ts`

```typescript
export type ActionType =
  | 'ACTION_SOL_TRANSFER'
  | 'ACTION_SPL_TRANSFER'
  | 'ACTION_JUPITER_SWAP'
  | 'ACTION_MY_NEW_ACTION';  // ← add here
```

### Step 2 — Add to decision logic in `packages/core/src/agent/decision.ts`

```typescript
const actions: ActionType[] = [
  'ACTION_SOL_TRANSFER',
  'ACTION_SPL_TRANSFER',
  'ACTION_JUPITER_SWAP',
  'ACTION_MY_NEW_ACTION',  // ← add here
];
```

### Step 3 — Implement in `apps/api/src/harness/runner.ts`

```typescript
case 'ACTION_MY_NEW_ACTION': {
  const result = await myNewOp(connection, {
    secretKey: keypair.secretKey,
    // ... other params
  });
  return {
    status: 'SUCCESS',
    signature: result.signature,
    explorerUrl: result.explorerUrl,
    amount: result.amount,
  };
}
// Always include the default case — TS will error without it:
default:
  return { status: 'FAILED', error: `Unknown action type: ${type}` };
```

### Step 4 — Add wallet op in `packages/core/src/wallet/walletOps.ts` (if needed)

```typescript
export async function myNewOp(
  connection: Connection,
  params: { secretKey: Uint8Array; /* ... */ }
): Promise<WalletOpResult> {
  // Build transaction
  // Sign with Keypair.fromSecretKey(params.secretKey)
  // Send via sendAndConfirmTransaction or sendRawTransaction
  // Return { signature, explorerUrl }
}
```

### Step 5 — Add Zod validator if new API params needed

Edit `apps/api/src/validators.ts`.

### Step 6 — Write tests

- Unit test in `apps/api/tests/unit/`
- Integration test in `apps/api/tests/integration/` (mark as skippable if devnet is down)

---

## Security Rules — Never Violate These

1. **Never log private keys** — the logger in `src/logger.ts` has key material redaction; use it, don't bypass it
2. **Never store plaintext keys** — always encrypt before writing to DB; always use `services/encryption.ts`
3. **Never import from `apps/api` in `packages/core`** — core must stay framework-agnostic and portable
4. **Always validate API inputs with Zod** — all route handlers must use validators from `validators.ts` before processing
5. **Decrypt in the smallest scope possible** — decrypt immediately before use inside `runner.ts`, not in route handlers
6. **All DB operations go through `services/db.ts`** — never write SQL inline in routes or runners
7. **Always handle `SKIPPED_NO_ROUTE`** — Jupiter devnet has unreliable liquidity; this is not an error, do not throw

---

## Error Handling Patterns

```typescript
// Jupiter swap — always check for no route
if (!quoteData.routePlan || quoteData.routePlan.length === 0) {
  return { status: 'SKIPPED_NO_ROUTE' };
}

// Insufficient funds — always check before executing
if (agent.solBalance < MIN_ACTION_SOL) {
  return { status: 'SKIPPED_INSUFFICIENT_FUNDS' };
}

// Transaction failure — catch and record, never throw up to harness
try {
  const sig = await sendAndConfirmTransaction(...);
  return { status: 'SUCCESS', signature: sig };
} catch (err) {
  return { status: 'FAILED', error: String(err) };
}
```

The harness runner must never crash due to a single agent failure. All action execution is wrapped in try/catch and recorded as `FAILED` with an error string.

---

## Environment Variables Reference

```bash
# apps/api/.env
PORT=3001
SOLANA_RPC_URL=https://api.devnet.solana.com
API_KEY=<strong random string>
AGENT_MASTER_KEY=<base64 32-byte key>        # used for AES-256-GCM agent key encryption
RECEIVER_PUBLIC_KEY=<devnet pubkey>           # destination for test transfers
FUNDER_SECRET_KEY=<base58 private key>        # optional: bypass devnet airdrop rate limits
MIN_AGENT_SOL=0.05                            # SOL given to each new agent
MIN_ACTION_SOL=0.01                           # minimum SOL required to execute an action
HARNESS_INTERVAL_MS=30000                     # loop interval in milliseconds
CORS_ORIGIN=https://your-vercel-app.vercel.app

# apps/web/.env.local
NEXT_PUBLIC_API_URL=https://your-railway-app.railway.app
NEXT_PUBLIC_API_KEY=<same as API_KEY>
```

---

## Running Tests

```bash
pnpm test                    # all tests
pnpm test:unit               # unit tests — no network required
pnpm test:integration        # devnet tests — skips if RPC is unavailable
cd apps/api && pnpm test:watch   # watch mode
```

Test locations:
- `apps/api/tests/unit/encryption.test.ts` — AES-256-GCM encrypt/decrypt roundtrip
- `apps/api/tests/unit/validators.test.ts` — Zod schema validation
- `apps/api/tests/unit/agentLogic.test.ts` — Decision engine unit tests
- `apps/api/tests/integration/devnet.test.ts` — Live devnet transaction tests

---

## What a Production Version Would Add

If you are an AI agent extending this system toward production, these are the gaps to address:

1. **Key custody**: Replace AES-256-GCM with HSM-backed storage (AWS CloudHSM, Azure Dedicated HSM) or MPC key shares (Shamir Secret Sharing across geographically distributed nodes)
2. **TEE execution**: Run the signing process inside an Intel SGX or AMD SEV enclave so even the operator cannot access key material
3. **Agent intelligence**: Replace `decideNextAction` round-robin with an LLM-driven agent (tool-calling Claude or GPT-4) that reads on-chain data, price feeds, and executes based on real signals
4. **Transaction simulation**: Simulate every transaction with `simulateTransaction` before broadcasting to catch failures before spending fees
5. **Database**: Replace SQLite with Postgres for concurrent writes and horizontal scaling
6. **Queue**: Replace the in-process harness loop with a proper job queue (BullMQ, Temporal) for reliability and observability
7. **Rate limiting**: Add per-agent action rate limits and circuit breakers to prevent runaway spending
