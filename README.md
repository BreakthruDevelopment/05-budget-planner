# Personal Budget Planner

> A "Mint/YNAB for our members" that fintech startups, credit unions, and financial coaches can white-label: connect a bank, categorize transactions without manual sorting, set monthly budgets, and read a plain-English cash-flow explanation that never gives financial advice.

**Live:** https://app5.breakthruventures.ai · **Runs on:** AWS (Lambda arm64 + RDS Postgres) · Part of [30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

> **Notice:** The live demo uses simulated and sandbox banking data. Never connect real bank credentials.

## What this app does

Fintech startups, credit unions, and financial coaches frequently need a ready-to-deploy budgeting experience for their users. Members want to connect their bank accounts, track categorized spending, establish monthly category limits, and understand their net cash flow.

Clients require:
1. **Bank data handled like bank data:** access tokens encrypted at rest with row-bound envelope encryption, never logged, and revocable on demand.
2. **Imports that never double-count:** robust, cursor-based synchronization that cleanly handles re-syncs, pending-to-posted transitions, and transaction removals.
3. **AI that categorizes and explains but never gives financial advice:** strict guardrails enforcing factual bookkeeping without unsolicited credit, investment, or debt counseling.

### Roles and Permissions

| Role | Can do |
| --- | --- |
| Public | View landing page with demo-data notice; sign up or sign in |
| `user` | Connect bank (built-in demo bank or Plaid sandbox), trigger syncs, disconnect; view own accounts and transactions; recategorize transactions (optionally "always for this merchant"); set monthly category budgets; view monthly cash flow; run AI transaction categorization and monthly cash-flow explanation |
| `admin` | View own data like any user, plus **counts only** across the system (users, linked bank items by provider, transactions, daily AI calls vs caps), trigger "Load demo workspace", and perform standard account management |

**Admin privacy isolation:** Admins never see another user's accounts, transactions, merchants, rules, or budgets. Every query filters strictly on `owner_id = actor.id`. Accessing another user's records returns an HTTP 404 rather than 403, preventing resource enumeration. Furthermore, Better Auth's `impersonate`, `set-password`, and `set-email` paths are disabled and excluded from admin permissions.

## Bank Provider (Demo & Plaid Sandbox)

The app abstracts bank integrations behind a `BankProvider` interface with two implementations:

- **`demo` (default):** A deterministic fake bank ("Breakthru Demo Bank") implemented entirely in code. It provides 2 accounts (checking, credit card) and ~150 simulated transactions across 90 days from a seeded PRNG, paginated in cursor batches of 50. Page 2 of a fresh sync deliberately emits one modified row (pending to posted, with `pending_transaction_id`) and one removed row, exercising synchronization idempotency on every connect. "Connecting" calls `exchange("demo")` with no Link modal required; no access token is stored and no external network calls are made.
- **`plaid`:** Enabled only when `PLAID_CLIENT_ID`, `PLAID_SECRET`, and a valid 32-byte base64 `TOKEN_ENC_KEY` are all present. If any of these secrets are missing, or if `BANK_PROVIDER=demo` is explicitly set, the app logs `bank.provider.fallback` (logging variable names only, never secret values) and defaults to `demo`. The Plaid base URL is **hardcoded to `https://sandbox.plaid.com`** (there is no `PLAID_ENV` setting), ensuring the codebase cannot touch billable environments. Integrations use lightweight `fetch` requests with a 10-second timeout and Zod schema validation (no heavy external Plaid SDK). Plaid Link is rendered on the client via `react-plaid-link` using test credentials (`user_good` / `pass_good`). Disconnecting calls `/item/remove` on Plaid and purges stored secrets locally.

`GET /api/health` reports the active provider as `bank: "demo"` or `bank: "plaid"` without disclosing credentials.

## Envelope Encryption and the KMS Trade-Off

Bank access tokens represent sensitive credentials requiring robust protection at rest.

### Two-Tier Envelope Encryption

Access tokens are protected using a two-tier envelope encryption architecture:
1. **DEK (Data Encryption Key):** A cryptographically random 32-byte DEK is generated per item and encrypts the token using AES-256-GCM with a 12-byte initialization vector (IV) and Additional Authenticated Data (AAD).
2. **KEK (Key Encryption Key):** The DEK is encrypted under the KEK via AES-256-GCM with its own 12-byte IV and AAD.
3. **Row-Bound AAD:** The AAD binds the ciphertext directly to the owning record:
   `budget-planner:bank_item_secret:<item_id>:<owner_id>`
   If a ciphertext is copied to another row or another user's item, AES-256-GCM authentication fails and decryption is rejected.
4. **Key Management & Rotation:** Ciphertext blobs are versioned (`{v: 1, kid, wiv, wdek, iv, ct}`) with a key identifier (`kid`, default `k1`). The system supports key rotation via `TOKEN_ENC_KEY_OLD` / `TOKEN_ENC_KEY_OLD_ID` to decrypt legacy secrets and re-wrap the DEK under the current active KEK.

Token ciphertexts are isolated in a separate `bank_item_secret` table that is never joined on standard listing queries. Tokens are decrypted only in memory within a dedicated scoped caller (`withAccessToken`), which discards references immediately after execution. Plaid error handlers log error codes and request IDs only, never response bodies or token fragments.

### The AWS KMS Trade-Off

- **Why not AWS KMS Customer Managed Keys (CMK)?** A customer-managed KMS key incurs a minimum charge of $1.00/month per key, which violates the strict $0 free-tier budget constraint for this portfolio.
- **The Chosen Trade-Off:** The KEK is stored in AWS Systems Manager Parameter Store as a `SecureString` using the default AWS-managed KMS key (which is completely free). Parameter Store injects the KEK as an environment variable into AWS Lambda, where AWS encrypts environment variables at rest.
- **Security Trade-Off:** Anyone who possesses IAM administrative access to read the Lambda function's configuration or environment variables can read the KEK. This trade-off is accepted to satisfy the zero-cost requirement while keeping tokens strongly encrypted within the database and database backups.

## Import Idempotency Rules

Importing bank transactions reliably requires handling pagination, mid-sync mutations, network interruptions, and user edits without duplicates or lost categories:

1. **Advisory Concurrency Lock:** `syncItem` acquires an advisory transaction lock (`pg_try_advisory_xact_lock`) keyed on the item ID. A concurrent sync request for the same bank item immediately returns HTTP 409 Conflict ("Already syncing").
2. **Cursor Pagination & Atomic Page Transactions:** Transaction updates are fetched using `/transactions/sync` in batches of 500. Each batch is written in its own database transaction alongside that page's `next_cursor`.
3. **Upsert Idempotency Key:** Records are keyed on the unique constraint `(item_id, provider_txn_id)`. Added and modified transactions use `INSERT ... ON CONFLICT (item_id, provider_txn_id) DO UPDATE`. Removed transactions are deleted from the database.
4. **Category Protection:** Re-syncing an existing transaction **never overwrites** a category assignment if `category_source` is set to `user` or `rule`.
5. **Pending-to-Posted Carry-Over:** When Plaid marks a pending transaction as posted, the new posted row matches the pending row's `pending_transaction_id`. The posted transaction automatically inherits any user- or rule-assigned category from the pending row before the pending row is deleted.
6. **Mutation During Pagination:** If Plaid returns `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, the synchronization loop restarts from the initial cursor held at the start of the refresh loop. Because writes are idempotent upserts, replaying pages causes no duplicate data.
7. **Execution Time Budget:** Sync operations enforce a 20-second execution time budget to stay safely within Lambda's 29-second hard timeout. If more pages remain when the budget elapses, the sync returns `{ more: true }`, prompting the UI to display a "Continue" button.
8. **Amount Sign Convention:** Plaid represents outflows as positive numbers. The database inverts this convention once at import: stored as `amount_cents` bigint where **positive = inflow** and **negative = outflow**. Only USD transactions count toward category budgets; other currencies are displayed with currency warning badges.
9. **Rate Limiting:** Bank synchronization is capped at 6 sync attempts per user per hour.

## AI Features & Safety Guardrails

The application provides two AI tasks via the shared `generate()` gateway, operating under Gemini (free tier) with fallback to deterministic recorded fixtures in `demo` mode.

### 1. Transaction Categorization (`categorize-transactions`)

Automatically classifies uncategorized transactions:
- **Input Capping & Sanitization:** Up to 50 transactions per call. IDs are mapped server-side to opaque keys (`T1` through `T50`). Merchant and transaction descriptions are truncated to 120 characters with angle brackets and newlines stripped. Exact dollar figures are omitted; only the transaction sign and amount bands (`<$20`, `$20-$100`, etc.) are provided. The prompt is capped at 8,000 characters.
- **Output Schema & Validation:** Zod schema validates `items: [{ id, category, confidence }]`. Unknown categories or duplicate IDs are discarded.
- **Confidence & Inflow Guardrails:** Classifications require a confidence score of >= 0.6 to be applied; low-confidence suggestions (< 0.6) remain categorized as `none` ("Needs review") with the suggested category presented as a clickable UI chip. Outflows can never be assigned `income`. User-assigned and rule-assigned categories are never overwritten.
- **Precedence Hierarchy:** `user` (manual edit) > `rule` (merchant rule) > `provider` (Plaid category mapping) > `ai` (confidence >= 0.6) > `none` (Needs review).

### 2. Monthly Cash-Flow Explanation (`explain-cash-flow`)

Provides a plain-English bookkeeping summary of monthly income, spending by category, budget status, and top merchants:
- **Prompt Sanitization:** The prompt receives aggregated statistics from `cashFlow()` (cents converted to two-decimal dollar figures, category totals, budget variances, and top merchant names stripped of markup). Maximum prompt length is 6,000 characters.
- **Bookkeeping Assistant Persona:** The system prompt explicitly instructs the model that transaction descriptions are untrusted data, not instructions. The model must only cite figures present in the input statistics.
- **Strict Advice Filter:** The model is prohibited from giving financial, investment, credit, debt, tax, or legal advice. Code guardrails check all outputs against a regex advice filter (`invest`, `stock`, `crypto`, `loan`, `refinanc`, `credit score`, `credit card`, `apr`, `tax`, `lawyer`, `bankrupt`). If matching advice keywords appear in highlights, the field is replaced with neutral factual text; if detected in the headline or summary, the entire response falls back to rule-built text (`mode: fallback`).
- **Number Verification:** Every dollar amount mentioned in the output must match a figure in the source statistics within $1 (to allow for rounding); otherwise, the sentence is replaced with neutral summary text.
- **Caching & Limits:** Explanations are cached per user per month in `cashflow_summary`. A month with zero transactions skips AI calls entirely (`mode: skipped`). Users may regenerate a month's explanation at most twice (maximum 3 model calls per month). The entire app is bound by `AI_DAILY_CAP` (300 calls/day).

## Architecture

```
Browser (mobile & desktop)
   │ HTTPS + session cookie
   ▼
AWS API Gateway ──► Lambda Web Adapter ──► Next.js container (App Router)
                         │                  auth + RBAC, zod validation, AI gateway, JSON logs
                         ├──► RDS Postgres (Drizzle migrations on startup)
                         ├──► Bank APIs (Plaid sandbox or built-in demo bank)
                         └──► Model API (Gemini free tier or demo fallback)
```

| Concern | Implementation | Location |
| --- | --- | --- |
| Environment Config | Startup schema validation | `src/lib/env.ts` |
| Database & Schema | Drizzle ORM + PostgreSQL | `src/lib/db/schema.ts`, `drizzle/` |
| Session & Roles | Better Auth + Admin Plugin | `src/lib/auth/` |
| Authorization & Access | Server-side `assertCan()` & `ownedBy()` | `src/lib/auth/rbac.ts` |
| Bank Integration | `BankProvider` (demo & Plaid sandbox) | `src/lib/bank/` |
| Envelope Encryption | AES-256-GCM envelope encryption | `src/lib/crypto/envelope.ts` |
| AI Gateway | Zod schemas, caps, demo fallback | `src/lib/ai/` |
| Advice Guardrails | Number validation & advice term filters | `src/lib/advice-guardrails.ts` |
| Liveness & Bank Health | `GET /api/health` | `src/app/api/health/route.ts` |

## Free-Tier Budget

The entire deployment runs comfortably within the AWS and provider free tiers:

| Resource | Control & Safeguards | Worst-Case Monthly Usage |
| --- | --- | --- |
| **AWS Lambda** (arm64, 1,024 MB) | Sync <= 20 s, AI <= 20 s; single container instance | Well under the 400,000 GB-s free tier |
| **AWS RDS** (shared db.t4g.micro, 20 GB) | Capped at <= 3 bank items and <= 5,000 transactions per user; demo bank has ~150 rows | ~1 KB/transaction; 1,000 users consumes ~0.5 GB |
| **Plaid** | Sandbox environment only (`https://sandbox.plaid.com`); no development or production environments | $0 (No billing relationship required) |
| **Google Gemini** | Transaction categorization capped at <= 50 rows (10 calls/hr/user); cash-flow summaries cached per month (<= 2 regenerations); `AI_DAILY_CAP=300` app-wide | Fully within Gemini free tier |
| **AWS Parameter Store** | Standard parameters (SecureString with default AWS-managed KMS key) | $0 (Free tier) |

## Environment Variables

Names only (never commit real secret values):

| Variable | Description |
| --- | --- |
| `APP_NAME` | Application display title (e.g. "Personal Budget Planner") |
| `APP_URL` | Public base URL (e.g. `https://app5.breakthruventures.ai`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | 32+ character key for session cookie encryption |
| `AI_PROVIDER` | AI provider choice (`demo`, `gemini`, or `anthropic`) |
| `AI_MODEL` | Optional model identifier override |
| `GEMINI_API_KEY` | Google Gemini API key (for categorization & cash-flow explanation) |
| `ANTHROPIC_API_KEY` | Optional Anthropic API key |
| `AI_FALLBACK_TO_DEMO` | When `true`, returns recorded demo fixtures on quota error or timeout |
| `AI_TIMEOUT_MS` | Gateway call timeout in milliseconds (default 20,000, max 22,000) |
| `AI_DAILY_CAP` | Application-wide daily limit on model calls (default 300) |
| `BANK_PROVIDER` | Bank provider flag (`demo` or `plaid`; defaults to `demo`) |
| `PLAID_CLIENT_ID` | Plaid sandbox client ID |
| `PLAID_SECRET` | Plaid sandbox secret |
| `TOKEN_ENC_KEY` | 32-byte base64 Key Encryption Key for envelope encryption |
| `TOKEN_ENC_KEY_ID` | Identifier for active KEK (defaults to `k1`) |
| `TOKEN_ENC_KEY_OLD` | Optional legacy KEK used during key rotation |
| `TOKEN_ENC_KEY_OLD_ID` | Identifier for legacy KEK |
| `LOG_LEVEL` | Minimum log verbosity (`debug`, `info`, `warn`, `error`) |
| `MIGRATE_ON_START` | When `true`, runs pending database migrations on startup |
| `SEED_ADMIN_EMAIL` | Optional initial admin email for `pnpm db:seed` |
| `SEED_ADMIN_PASSWORD` | Optional initial admin password for `pnpm db:seed` |

## Run Locally

```bash
# 1. Clone repository and install dependencies
pnpm install

# 2. Start PostgreSQL container
docker compose up -d db

# 3. Configure local environment variables
cp .env.example .env.local
# Generate BETTER_AUTH_SECRET: openssl rand -base64 32
# Optional: generate TOKEN_ENC_KEY: openssl rand -base64 32

# 4. Run database migrations
pnpm db:migrate

# 5. Start development server
pnpm dev # http://localhost:3000
```

To create an admin account locally:
```bash
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD=your-secure-password pnpm db:seed
```

To seed sample workspace data for demoing:
```bash
DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD=DemoPassword123! pnpm seed:demo
```

## Checks

```bash
pnpm lint                                  # ESLint code style
pnpm typecheck                             # TypeScript compiler check
pnpm test                                  # Unit tests and AI mock evals
TEST_DATABASE_URL=postgres://... pnpm test # Integration tests against PostgreSQL
pnpm build                                 # Production Next.js build
pnpm smoke                                 # End-to-end smoke test suite
```

## Deploy It Yourself

Every push to `main` publishes a multi-architecture container image (x86_64 and arm64) to GitHub Container Registry (`ghcr.io/breakthrudevelopment/05-budget-planner`). Infrastructure is deployed with Terraform via [BreakthruDevelopment/30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra) onto AWS Lambda behind API Gateway with RDS PostgreSQL.

Secrets (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `TOKEN_ENC_KEY`, `BETTER_AUTH_SECRET`) are provisioned in AWS Systems Manager Parameter Store as SecureStrings and injected as environment variables.

## 2-Minute Demo Script

Follow this sequence to demo the application's core functionality, bank isolation, and guardrails in under two minutes:

1. **Sign Up & View Landing Page (`/`):**
   - Visit `https://app5.breakthruventures.ai`.
   - Note the clear "Demo and sandbox data only" banner warning users never to link real bank accounts.
   - Click **Sign In** and register a new user account.
   - *Proves: Self-service sign-up and explicit financial safety disclosures.*
2. **Connect the Demo Bank (`/accounts`):**
   - Navigate to the **Accounts** tab and click **Connect Demo Bank**.
   - Notice that two accounts (Checking and Credit Card) appear immediately with current and available balances, along with ~150 imported transactions.
   - Click **Refresh** to verify idempotency: the transaction count remains identical, confirming that duplicate imports are ignored.
   - *Proves: Out-of-the-box demo bank integration and sync idempotency.*
3. **Recategorize with "Always for this merchant" (`/transactions`):**
   - Navigate to **Transactions**. Find an "Uber" ride transaction listed with `transport` or uncategorized.
   - Change its category to **Transport** (or **Travel**) and toggle **"Always use for this merchant"**.
   - *Proves: Dynamic merchant rule creation that immediately updates other matching uncategorized transactions.*
4. **Set a Category Budget & Check Overview (`/budgets` & `/overview`):**
   - Go to **Budgets** and set a monthly limit for **Dining** (e.g. $250).
   - Switch to **Overview**. Observe the monthly spend bar against the dining limit: if actual spending exceeds $250, the progress bar shifts to the danger token.
   - *Proves: Responsive budget tracking, spending comparison, and mobile-friendly progress indicators.*
5. **Generate Monthly Cash-Flow Explanation (`/overview`):**
   - On the Overview page, click **Explain this month** in the summary panel.
   - View the AI-generated breakdown: headline, category highlights, over-budget alerts, and budgeting tips.
   - Notice the footer label: *"AI summary, not financial advice"*. All numbers reflect exact figures from the statistics table without speculative advice.
   - Click **Explain this month** a second time to show that the cached summary returns instantly without calling the model again.
   - *Proves: Factual bookkeeping summary, advice guardrails, and monthly response caching.*
6. **Verify Admin Isolation (`/admin`):**
   - Sign out and sign in with the admin account (or review the admin view).
   - Go to `/admin`. The dashboard displays aggregate counts: total registered users, linked items by provider (Demo vs Plaid), total transactions, and daily AI usage against caps.
   - Confirm that administrators have no access to browse user accounts, transactions, or merchant rules.
   - *Proves: Strict privacy isolation and administrative governance.*
