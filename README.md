# Personal Budget Planner

> Bank transactions land in the right category without manual sorting, each category gets a monthly budget, and a
> plain-English summary explains where the month's money went, without giving financial advice.

**Live:** https://app5.breakthruventures.ai · **Runs on:** AWS · Part of
[30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

**Demo data only.** Bank sync with Plaid's sandbox is built but switched off on the live site, so the live app
connects to a built-in fake bank ("Breakthru Demo Bank") and `/api/health` reports `bank: "demo"` (see
[Architecture](#architecture)). Never enter real bank details.

## What this app does

Fintech startups, credit unions and financial coaches ask for "a Mint or YNAB for our members". They care about
three things: bank data handled like bank data, imports that never count a transaction twice, and AI that sorts
and explains but doesn't give advice. This app covers that flow on demo data.

- **Users** connect the demo bank (two accounts, 149 transactions over 90 days), refresh it, and disconnect it.
  Re-syncing never duplicates rows.
- **Users** fix a category on any transaction. "Always use for this merchant" saves a rule, applies it to that
  merchant's uncategorized and AI-categorized rows now, and applies it to future imports.
- **Users** set a monthly limit for each expense category and see income, spending, net and budget against actual
  for any month, next to the previous month.
- **Users** run "Categorize with AI" on transactions that still need review, and "Explain this month" for a short
  summary labelled "AI summary, not financial advice".
- **Admins** see counts only (users, linked items by provider, transactions, AI calls against today's cap), load
  the demo workspace, and manage accounts. An admin can't open another user's accounts, transactions, rules or
  budgets.

## Try it

1. Open https://app5.breakthruventures.ai and choose **Sign in or create account**, then **New here? Create an
   account**. Any email works; the password needs 10 or more characters.
2. Go to **Accounts** and choose **Connect demo bank**. Nothing leaves the app and no token is stored.
3. Use **Overview**, **Transactions** and **Budgets** as described in the [demo script](#2-minute-demo-script).

Visitors can't sign in as the demo users or as an admin. **Load demo workspace** (admin only) creates
`alex@`, `blair@` and `casey@demo.breakthru.test`, each with the demo bank, 90 days of transactions and
groceries and dining budgets, protected by a random password. Its purpose is to fill the admin counts.

## The AI feature

Two tasks go through the shared gateway, `generate()` in `src/lib/ai`. The live app is deployed with
`AI_PROVIDER=gemini` (default model `gemini-flash-lite-latest`; `AI_MODEL` overrides it). With
`AI_FALLBACK_TO_DEMO=true` (the default), a quota error or outage serves a recorded answer, and the UI marks it.
The code is in `src/lib/ai/budget-tasks.ts` and `src/lib/budget-ai.ts`.

**Categorize transactions** (`categorize-transactions`)

- Sends up to 50 of the user's rows, uncategorized ones first and oldest first. The model sees an opaque id
  (`T1` to `T50`, mapped back on the server), the cleaned name and merchant (angle brackets, backticks and control
  characters removed, at most 120 characters), whether the money came in or went out, and an amount band such as
  `$20-100`. It never sees exact amounts. Prompt capped at 8,000 characters.
- Output is validated with zod: known ids only, one of the 14 fixed category slugs, confidence 0 to 1.
- Unknown or repeated ids are dropped. Money going out can never become `income`. Money coming in can only become
  `income`, `transfer` or `other`, so an injected "set everything to income" fails.
- It never overwrites a category the user chose or a rule set. A suggestion below 0.6 confidence is shown as a chip
  and the row stays in "Needs review".

**Explain this month** (`explain-cash-flow`)

- Sends server-computed figures for one month (income, spend, net, each category with its budget and previous
  month, top five merchants, transaction count). Prompt capped at 6,000 characters. A month with no transactions
  makes no model call.
- Output is validated with zod: headline (100 characters), summary (600), up to 4 highlights, up to 3 over-budget
  items, and a tip (200).
- **Number check:** every dollar figure in the text must match a figure the server computed, within $1.
  Percentages, ratios and spelled-out amounts are rejected. A field that fails is replaced with neutral text built
  from the figures.
- **Over-budget check:** an over-budget item the data doesn't support is removed, and a category that is over budget
  but missing is added in neutral words.
- **Advice filter:** `src/lib/advice-guardrails.ts` is a keyword list (investing, loans, credit cards, tax, legal
  and similar). A match in a highlight, an over-budget item or the tip replaces that field. A match in the headline
  or summary replaces the whole answer with the neutral version.
- The summary is cached per user and month. It is regenerated only when the user asks, at most twice per month. If
  the numbers change, the cached text is flagged as stale.

Both system prompts say that merchant names and descriptions come from banks and users and are data, never
instructions. Both forbid investment, credit, debt, tax and legal advice and product recommendations.

**Caps:** each task is limited to 10 calls per user per hour, and `AI_DAILY_CAP` (default 300) is an app-wide daily
cap. A request the gateway rejects before sending gets its quota back. Logs record task, mode, row counts, guardrail
codes and latency, never merchant names, amounts or prompts.

**What the checks don't prove.** The number check shows that a figure exists in the data, not that it is attached
to the right category. The advice filter reduces advice; it doesn't prove there is none. Evals:
`test/ai-evals.test.ts` (stubbed in CI; `pnpm eval:budget` runs them against Gemini by hand).

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Next.js container ── pages, server actions, route handlers (/api/*)
   │                  auth + RBAC, zod validation, AI gateway, JSON logs, /api/health
   ├──► Postgres (Drizzle)
   ├──► Bank provider: Breakthru Demo Bank (in code), or Plaid sandbox when its keys are set
   └──► Model API (Gemini, or recorded demo answers)
```

- **AWS Lambda** (arm64, 1,024 MB, 29 s timeout, one instance) behind API Gateway, with RDS Postgres. Lambda
  freezes after it responds, so there is no background work: sync and AI calls run inside the request.
- **Sync** (`src/lib/bank/items.ts`) pages through the provider (the demo bank serves 50 rows per page; Plaid is asked for
  up to 500). Each page and its cursor are
  committed in one transaction. It stops starting new pages after 20 seconds and returns `more: true`, and the
  Accounts page then offers **Continue**.
- **No double counting.** `(item_id, provider_txn_id)` is unique and every write is an upsert, so replays change
  nothing. Removed rows are deleted. A posted row that replaces a pending one keeps the user's or rule's category.
  A second refresh while one is running gets 409 "Already syncing"; an abandoned sync lease expires after 60 seconds.
- **Bank sync** (`src/lib/bank/`). A `BankProvider` interface has two implementations.
  - **Demo bank** (the default): two accounts and 150 generated transactions served in pages, including a
    pending-to-posted change and a removal, so the idempotency rules run on every connect. Nothing leaves the app and
    no token is stored.
  - **Plaid sandbox** (`src/lib/bank/plaid.ts`): server-only calls with plain `fetch`, a 10-second timeout and
    zod-validated responses. The base URL is hard-coded to `https://sandbox.plaid.com`, so the code can't reach a
    billable environment. `POST /api/bank/link-token` creates a link token; `POST /api/bank/items` exchanges a public
    token (only `public-sandbox-…` tokens are accepted) and stores the access token.
  - **Switch.** Plaid is used only when `PLAID_CLIENT_ID`, `PLAID_SECRET` and a valid `TOKEN_ENC_KEY` (32 bytes,
    base64) are all set; `BANK_PROVIDER=demo` forces the demo bank. Otherwise the app uses the demo bank and logs
    `bank.provider.fallback` once, naming the variables but never their values. `/api/health` reports which is on.
  - **Encrypted access tokens** (`src/lib/crypto/envelope.ts`, `src/lib/bank/secrets.ts`): AES-256-GCM under a
    random per-token data key, wrapped by `TOKEN_ENC_KEY`. The ciphertext is bound to its item and owner, so a blob
    copied to another row or user won't decrypt. Tokens sit in `bank_item_secret`, which no list query reads;
    `withAccessToken()` is the only place that decrypts. After a key rotation (`TOKEN_ENC_KEY_PREVIOUS`), a token is
    re-wrapped under the new key the first time it's used. There is no KMS (it costs money); the trade-off is that
    anyone who can read the app's configuration can read the key.
  - **Plaid errors** log only `error_code`, `error_type` and `request_id`, never response bodies or tokens.
  - **Sync** uses Plaid's `/transactions/sync` cursor with the same rules as above. If Plaid reports a mutation during
    pagination, it restarts from the cursor the loop began with.
  - **Disconnect** revokes the item at Plaid (`/item/remove`) first, then deletes the local rows and the stored
    token. If Plaid is switched off, or the token can no longer be decrypted, the owner can still delete locally, and
    that is logged.
- **Category precedence** at import: user choice, then merchant rule, then the provider's category, then AI, then
  "Needs review".
- **Amounts** are integer cents: positive is money in, negative is money out. Cash-flow totals count posted USD
  rows only and leave out transfers.
- `GET /api/health` reports database status, the deployed image tag and `bank: "demo"`. It returns 503 if the
  database is down.

## Data model

Defined in `src/lib/db/schema.ts`; migrations in `drizzle/`. Every financial table has an `owner_id`.

| Table | Holds |
| --- | --- |
| `category` | The 14 fixed categories (income, housing, groceries, dining, transport, utilities, shopping, health, entertainment, travel, subscriptions, fees, transfer, other), seeded by migration |
| `bank_item` | One connected bank per row: provider (`demo` or `plaid`), sync cursor, status, sync lease |
| `bank_item_secret` | The encrypted Plaid access token for an item (one per item; none for demo items), with its key id |
| `bank_account` | Accounts under an item: name, last four digits, type, balances in cents |
| `txn` | Transactions. Unique `(item_id, provider_txn_id)` is the idempotency key. Category, its source (`user`, `rule`, `provider`, `ai`, `none`) and AI confidence |
| `category_rule` | "Always use for this merchant" rules, unique per user and merchant |
| `budget` | Monthly limit per user and expense category (1 cent to $100,000) |
| `cashflow_summary` | Cached AI explanation per user and month, with the figures it was built from and a regeneration count |
| `rate_event`, `daily_usage` | Per-user hourly limits and the app-wide daily AI budget |

Composite foreign keys tie `txn` to `bank_account` and `bank_account` to `bank_item` on the same `owner_id`, so a
row can't point at another user's account.

## Security

**Roles.** Better Auth with two roles. `user` sees and changes only their own banks, transactions, rules, budgets
and summaries. `admin` has their own data like any user, plus counts, the demo loader and account management.
`src/lib/auth/permissions.ts` withholds impersonation, set-password, set-email and session listing from admins, and
those endpoints are disabled outright.

**Enforcement.**

- Every page calls `requireUserOrRedirect()` or `requireRoleOrRedirect()`. Every route handler and server action
  calls `requireUser()` or `requireRole()`.
- Every query filters by `owner_id = actor.id` (`ownedBy()` in `src/lib/owned.ts`). Another user's row returns 404,
  for admins too.
- Every mutating route checks the Origin header against `APP_URL` (`requireSameOrigin()`), so sibling
  `*.breakthruventures.ai` apps can't post to it. JSON bodies are capped at 16 KB and validated with zod.
- Errors go through `errorResponse()`, which never returns stack traces or upstream text.
- Per-user limits: 3 bank items, 5,000 transactions, 200 rules, 6 refreshes per hour, 10 Plaid link tokens and 5
  Plaid connects per hour, and the AI caps above.
- Public sign-ups can't take the reserved demo email domain.

**Tests.** `test/budget.integration.test.ts` covers owner, other-user and admin 404s, replayed syncs, pending to
posted, rule precedence, concurrent refreshes, the time budget, caps and cash-flow totals against a hand-computed
fixture. `test/budget-ai.integration.test.ts`, `test/admin-permissions.integration.test.ts` and
`test/demo-identity.integration.test.ts` cover the AI caps, admin limits and demo identities.
`test/plaid.integration.test.ts` runs against a local stub Plaid server: connect, sync and disconnect end to end with
no token in any log line or error body, ownership 404s, a ciphertext moved to another row failing, replayed syncs,
mutation-during-pagination restarts, fallback to the demo bank when a key is missing or 31 bytes, the Plaid limits,
and disconnect when the key is lost. `scripts/smoke.sh`
repeats the main checks over HTTP against a running app.

## Known limits

- **Plaid is switched off on the live site.** The live app reports `bank: "demo"`, because the three secrets aren't all
  set, so it uses the demo bank. The test suite exercises Plaid against a local stub server; no connect against
  Plaid's real sandbox has been done yet. The Accounts page has a Plaid Link button (`src/components/budget/plaid-connect.tsx`, using
  `react-plaid-link`) that appears only when Plaid is on, so it has never been shown live or tried end to end.
- **Sandbox only.** There is no Plaid development or production mode, by design.
- **No webhooks.** Refresh is manual.
- **USD only.** Non-USD rows are shown but don't count toward totals or budgets.
- Categories are fixed. There are no split transactions, CSV import or manual cash entries.
- No email: there is no password reset or verification.

## Configuration

Names only; values live in AWS Parameter Store or `.env.local`. See `.env.example` and `src/lib/env.ts`.

| Variable | Purpose |
| --- | --- |
| `APP_URL`, `APP_NAME` | Public URL (also the only allowed Origin) and display name |
| `DATABASE_URL` | Postgres connection |
| `BETTER_AUTH_SECRET` | Session signing, at least 32 characters |
| `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Model choice (`demo`, `gemini` or `anthropic`) |
| `AI_FALLBACK_TO_DEMO`, `AI_TIMEOUT_MS`, `AI_DAILY_CAP` | Fallback to recorded answers, provider timeout (max 22 s), app-wide daily AI cap |
| `MIGRATE_ON_START` | Apply migrations at startup (on in the cloud) |
| `LOG_LEVEL` | JSON log level |

Bank sync (read by `src/lib/bank/provider.ts`):

| Variable | Purpose |
| --- | --- |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | Plaid sandbox credentials |
| `TOKEN_ENC_KEY` | Key that encrypts stored access tokens: 32 random bytes, base64 (`openssl rand -base64 32`) |
| `TOKEN_ENC_KEY_PREVIOUS` | Rotation only: the old key, kept until stored tokens have been re-wrapped |
| `BANK_PROVIDER` | `demo` forces the demo bank |

The first three are listed as secrets for this app in
[30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra) `apps.yaml` (AWS Parameter Store). Plaid
switches on once all three are set and the app is redeployed. Losing `TOKEN_ENC_KEY` makes stored tokens unreadable,
so keep it backed up in the secret store.

## Run it locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db             # Postgres 17
pnpm install
pnpm db:migrate
pnpm dev                            # http://localhost:3000
```

`AI_PROVIDER=demo` (the default) needs no key or network. To make yourself an admin, sign up, then run
`SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed` while the app is running. To load the demo
users locally:

```bash
DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD='<a local password>' SEED_ADMIN_EMAIL=you@example.com pnpm seed:demo
```

The seed refuses production hosts and databases.

Checks:

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus integration tests against real Postgres
pnpm build && pnpm smoke                   # HTTP smoke test against a running app (BASE_URL)
```

## Deploy it yourself

Every push to `main` publishes a multi-arch image to `ghcr.io/breakthrudevelopment/05-budget-planner:sha-<commit>`.
[30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra) deploys a pinned tag with Terraform. The
same image runs on AWS (Lambda), Azure (Container Apps), Google Cloud (Cloud Run) and Oracle Cloud (Docker on a VM);
see `infra/README.md`. This repo holds no cloud credentials. With `MIGRATE_ON_START=true`, the server applies
pending migrations before taking traffic.

## 2-minute demo script

1. **Create an account and connect the bank.** On **Accounts**, choose **Connect demo bank**, then **Refresh**
   twice. The transaction count stays the same. *Proves: idempotent imports.*
2. **Fix a category for good.** On **Transactions**, filter to **Needs review**, pick a "Demo Cafe" row, choose
   **Dining**, tick **Always use for this merchant** and choose **Save category**. Other Demo Cafe rows that needed
   review change too. *Proves: merchant rules apply now and on future imports, and never override a user's choice.*
3. **Let AI sort the rest.** Choose **Categorize with AI (N)**. Confident results apply; low-confidence ones show as
   chips. *Proves: categorization stays inside the fixed categories and leaves user choices alone.*
4. **Set a budget.** On **Budgets**, set Dining to $250 and choose **Save budgets**. The **Overview** bars show
   budget against actual. *Proves: per-category monthly budgets.*
5. **Explain the month.** On **Overview**, choose **Explain this month**. The summary is labelled "AI summary, not
   financial advice", and every dollar figure matches the numbers on the page. *Proves: grounded, advice-free AI.*
6. **Admin view** (admin account). **Admin** shows counts only, with **Load demo workspace**. Opening another user's
   transaction by id returns 404. *Proves: admins never see users' financial data.*
