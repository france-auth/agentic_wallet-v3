# ◈ Agentic Wallet Sandbox

> **⚠️ PROTOTYPE WARNING**: This is a devnet-only prototype built for demonstration purposes. It uses Solana **devnet** and does NOT involve real funds. **Do NOT use production private keys, mainnet wallets, or real SOL.** The encryption and security measures are appropriate for a prototype, not a production system.

A multi-agent autonomous wallet system on Solana devnet. AI agents create their own wallets, hold SOL and SPL tokens, make independent financial decisions, and automatically execute transactions — including Jupiter DEX swaps — without any human intervention. All activity is observable through a live Next.js dashboard.

🔗 **Live Demo**: [https://your-vercel-app.vercel.app](https://your-vercel-app.vercel.app)
🔗 **API**: [https://your-railway-app.railway.app](https://your-railway-app.railway.app)

---

## What This Demonstrates

This project satisfies the Agentic Wallet bounty requirements:

| Requirement | Implementation |
|---|---|
| Create wallet programmatically | `POST /agents/create` — generates keypair, encrypts private key with AES-256-GCM |
| Sign transactions automatically | Agent decrypts key at runtime, signs and broadcasts without human input |
| Hold SOL and SPL tokens | Each agent wallet holds both; balances tracked in real time |
| Interact with a test protocol | Jupiter Swap API v6 integration — live DEX routing on devnet |
| Multiple agents independently | Each agent has isolated keypair, encrypted storage, and independent action history |
| Safe key management | AES-256-GCM encryption with env-var master key; keys never logged or stored plaintext |
| Observable frontend | Next.js dashboard with live action feed, per-agent detail, and Solana Explorer links |
| Working devnet prototype | Deployed and live; all transactions verifiable on-chain |

---

## Deep Dive: Wallet Design, Security & Agent Architecture

### How the Agentic Wallet Works

Traditional wallets require a human to approve each transaction. An agentic wallet flips this: the **agent holds its own key** and makes autonomous decisions about when and how to use it.

Each agent in this system is an independent entity with:
- A unique Ed25519 keypair (Solana's native signature scheme)
- An encrypted private key stored in SQLite
- Its own SOL balance, SPL token balance, and SPL mint address
- An action history log with on-chain signatures

The lifecycle of one agent decision cycle:

```
1. Harness wakes up (every 30s by default)
2. Loads agent record from DB (public key, encrypted secret key, balances)
3. Decrypts secret key in memory using AES-256-GCM + master key from env
4. Calls decideNextAction(context) → returns ACTION_TYPE
5. Calls executeAction(connection, agent, keypair)
6. Signs transaction locally — private key never leaves the process
7. Broadcasts to Solana devnet via sendAndConfirmTransaction
8. Records result (signature, status, amount) to DB
9. Zeroes out the keypair reference — GC handles cleanup
```

### Key Management & Security Model

**Encryption**: Each agent's 64-byte secret key is encrypted with AES-256-GCM before storage. The encryption key (AGENT_MASTER_KEY) is a 32-byte random value stored as a base64 env var — never in the database or codebase.

```
stored in DB:  iv (12 bytes) + ciphertext (80 bytes) + authTag (16 bytes)
never stored:  plaintext secret key
never logged:  any key material (redaction layer in logger)
```

**Decryption scope**: Keys are decrypted immediately before transaction signing and the plaintext reference is not retained. This minimises the window during which plaintext key material exists in memory.

**API authentication**: All mutating endpoints require an `x-api-key` header validated server-side. The key is set via env var and never hardcoded.

**What this is NOT**: This is a prototype. A production agentic wallet would use hardware security modules (HSMs), trusted execution environments (TEEs like Intel SGX), or multi-party computation (MPC) to ensure keys are never accessible even to the operator. This prototype demonstrates the architecture and mechanics, not production-grade key custody.

### Agent Decision Logic

The decision engine (`packages/core/src/agent/decision.ts`) simulates autonomous financial reasoning. It uses a round-robin strategy weighted by available balance:

```
if SOL balance < MIN_ACTION_SOL → skip (SKIPPED_INSUFFICIENT_FUNDS)
else rotate through:
  → ACTION_SOL_TRANSFER   (transfer SOL to receiver wallet)
  → ACTION_SPL_TRANSFER   (transfer SPL tokens to receiver)
  → ACTION_JUPITER_SWAP   (swap SOL → SPL via Jupiter)
```

This separation is intentional: **the decision logic in `packages/core` is completely independent of the wallet infrastructure in `apps/api`**. In a real system, this layer would be replaced by an LLM-driven agent (e.g. GPT-4, Claude) that reads market data and makes more sophisticated decisions. The wallet layer below it would remain unchanged.

### Jupiter Swap Integration

Jupiter is Solana's leading DEX aggregator. The swap flow:
1. Request a quote from Jupiter's Quote API (`/quote?inputMint=...&outputMint=...&amount=...`)
2. If a route exists, request a swap transaction (`/swap`)
3. Deserialize the returned transaction, sign with the agent's keypair
4. Broadcast via `sendRawTransaction`

On devnet, Jupiter has limited liquidity — swaps frequently return `SKIPPED_NO_ROUTE`. This is expected and handled gracefully without crashing the harness.

### Scalability

The current architecture supports N independent agents limited only by:
- SQLite write throughput (suitable for devnet prototype; swap for Postgres in production)
- Solana devnet RPC rate limits (use a dedicated RPC endpoint for higher throughput)
- The harness runs agents sequentially in a single process (parallelise with worker threads or a queue for production)

Each agent is fully isolated — one agent failing or having insufficient funds does not affect others.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web (Next.js 14, App Router)    Observer Dashboard    │
│  ┌──────────┐ ┌───────────┐ ┌─────────────────────────┐   │
│  │Dashboard │ │ /actions  │ │  /agents/[id]  detail    │   │
│  └──────────┘ └───────────┘ └─────────────────────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTP REST + x-api-key
┌─────────────────────────▼───────────────────────────────────┐
│  apps/api (Express + TypeScript)                            │
│  ┌────────────────┐   ┌──────────────────────────────────┐ │
│  │ REST routes    │   │  Harness Runner (in-process loop)│ │
│  │ POST /agents   │   │  · decideNextAction (core)       │ │
│  │ GET  /agents   │   │  · executeAction                 │ │
│  │ GET  /actions  │   │    SOL / SPL / Jupiter swap      │ │
│  │ POST /harness  │   └───────────────┬──────────────────┘ │
│  └───────┬────────┘                   │                     │
│  ┌───────▼────────────────────────────▼──────────────────┐ │
│  │  db (SQLite/better-sqlite3)                           │ │
│  │  encryption (AES-256-GCM)                             │ │
│  │  solana (connection, airdrop, mint helpers)           │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────┬───────────────────────────────────┘
                          │ @solana/web3.js + @solana/spl-token
┌─────────────────────────▼───────────────────────────────────┐
│  packages/core (shared, framework-agnostic)                 │
│  · walletOps: transferSol / transferSpl / jupiterSwap       │
│  · agent/decision: decideNextAction (rule-based)            │
│  · types: AgentRecord, ActionRecord, HarnessStatus, …       │
└─────────────────────────┬───────────────────────────────────┘
                          │ JSON RPC
          ┌───────────────▼──────────────┐
          │   Solana Devnet + Jupiter v6  │
          └──────────────────────────────┘
```

---

## Quickstart

### Prerequisites

- Node.js 18+
- pnpm 9+

```bash
npm install -g pnpm
```

### 1. Clone and install

```bash
git clone https://github.com/france-auth/agentic_wallet-v3
cd agentic-wallet-sandbox
pnpm install
```

### 2. Configure the API

```bash
cp apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env`:

```bash
PORT=3001
SOLANA_RPC_URL=https://api.devnet.solana.com

# Generate a 32-byte master key for agent key encryption
# Run: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
AGENT_MASTER_KEY=<paste base64 output here>

# API authentication key — set anything strong
API_KEY=my-secure-api-key-here

# Any valid devnet public key to receive test transfers
RECEIVER_PUBLIC_KEY=<any devnet public key>

# Optional: funder wallet for bypassing devnet airdrop rate limits
# FUNDER_SECRET_KEY=<base58 private key of a funded devnet wallet>
MIN_AGENT_SOL=0.05
MIN_ACTION_SOL=0.01

# How often the harness loop runs (ms)
HARNESS_INTERVAL_MS=30000

# Your Vercel app URL (for CORS)
CORS_ORIGIN=http://localhost:3000
```

### 3. Configure the web dashboard

```bash
cp apps/web/.env.example apps/web/.env.local
```

Edit `apps/web/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_API_KEY=my-secure-api-key-here   # same value as API_KEY above
```

### 4. Start both services

```bash
# Terminal 1 — API
pnpm dev:api
# → http://localhost:3001

# Terminal 2 — Dashboard
pnpm dev:web
# → http://localhost:3000
```

### 5. Run tests

```bash
pnpm test              # all tests
pnpm test:unit         # unit only (no devnet required)
pnpm test:integration  # live devnet tests
```

---

## 3-Minute Demo Walkthrough

**Step 1 — Create agents**
```bash
curl -X POST http://localhost:3001/agents/create \
  -H "Content-Type: application/json" \
  -H "x-api-key: my-secure-api-key-here" \
  -d '{"count": 3}'
```
Creates 3 agents, airdrops 0.5 SOL each, creates a shared SPL mint, mints tokens to each.

**Step 2 — View the dashboard**
Open [http://localhost:3000](http://localhost:3000). You'll see 3 agents with live SOL and SPL balances.

**Step 3 — Trigger one agent manually**
```bash
curl -X POST http://localhost:3001/agents/<id>/run-once \
  -H "x-api-key: my-secure-api-key-here"
```
Watch the Actions feed update. Click the row to see the transaction signature and Explorer link.

**Step 4 — Start the autonomous loop**
```bash
curl -X POST http://localhost:3001/harness/start \
  -H "Content-Type: application/json" \
  -H "x-api-key: my-secure-api-key-here" \
  -d '{"intervalMs": 15000}'
```
Agents now autonomously execute actions every 15 seconds. No further human input needed.

**Step 5 — Verify on-chain**
Click any action row → bottom sheet → "View on Solana Explorer". Every transaction is real and verifiable on devnet.

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | System health + harness status |
| `POST` | `/agents/create` | Create N agents with funded wallets |
| `GET` | `/agents` | List all agents with balances |
| `GET` | `/agents/:id` | Get single agent detail |
| `POST` | `/agents/:id/run-once` | Trigger one decision cycle for agent |
| `POST` | `/agents/:id/fund` | Fund agent from funder wallet or airdrop |
| `POST` | `/agents/run-all-once` | Run one cycle for all agents |
| `POST` | `/agents/fund-all` | Fund all agents below threshold |
| `GET` | `/agents/funder-info` | Funder wallet status and balance |
| `GET` | `/actions` | Action history (paginated, filterable) |
| `POST` | `/harness/start` | Start automatic loop |
| `POST` | `/harness/stop` | Stop automatic loop |

All endpoints except `GET /health` require `x-api-key` header.

---

## Scripts

| Command | Description |
|---|---|
| `pnpm dev:api` | Start API in dev mode (tsx watch) |
| `pnpm dev:web` | Start Next.js dev server |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all tests |
| `pnpm test:unit` | Unit tests only |
| `pnpm test:integration` | Devnet integration tests |
| `pnpm format` | Format all files with Prettier |

---

## Deployment

This project is deployed as a split stack:

- **Backend (Railway)**: `apps/api` — Node.js Express server
- **Frontend (Vercel)**: `apps/web` — Next.js 14 App Router

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full Railway + Vercel setup instructions.

---

## Funder Wallet

The Solana devnet faucet is heavily rate-limited. If you have a devnet wallet with SOL, configure it as a funder to bypass this:

```bash
# apps/api/.env
FUNDER_SECRET_KEY=your_base58_private_key_here
```

The API will fund new agents directly from this wallet instead of calling `requestAirdrop`. If the funder runs dry, agents are marked `NEEDS_FUNDING` and skipped by the harness until topped up.

---

## Troubleshooting

**429 RPC rate limit errors**
Switch to a dedicated devnet RPC — [Helius](https://helius.dev), [QuickNode](https://quicknode.com), and [Alchemy](https://alchemy.com) all offer free devnet tiers. Set `SOLANA_RPC_URL` in `.env`.

**Airdrop failures**
Devnet airdrops are unreliable. The system retries 5 times with exponential backoff. You can also manually airdrop:
```bash
solana airdrop 1 <agent-public-key> --url devnet
```

**Jupiter SKIPPED_NO_ROUTE**
Jupiter has limited liquidity on devnet. This is expected — the harness handles it gracefully and moves on to the next action type on the next cycle.

**SQLite DB not found**
Created automatically at `apps/api/data/agents.db` on first run.

---

## Security Considerations

See [SECURITY.md](./SECURITY.md) for the full threat model, known limitations, and what would be required to harden this for production use.

**Short version**: This prototype uses AES-256-GCM for key encryption, which is appropriate for a sandboxed devnet demonstration. A production system would require HSM-backed key custody, TEE-based execution, or MPC key shares — none of which are in scope for this prototype.
