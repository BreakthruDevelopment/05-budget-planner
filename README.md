# Personal Budget Planner

A private demo-bank budget planner in Breakthru Ventures' **30 apps in 30 days** portfolio.

## What this app does

Personal Budget Planner imports deterministic demo bank transactions, applies merchant rules, stores recurring category budgets, and computes monthly cash flow. Every financial query is scoped to the acting user, including for admins; admins see counts only. **Demo and sandbox data only. Never connect a real bank.**

This data/API release includes the 14 fixed categories, demo connect/sync/disconnect, keyset transaction pagination, recategorization with “always for this merchant”, budgets, cash flow, admin counts, and demo workspace loading. Dedicated UI, AI and encrypted Plaid sandbox support follow in separate issues. `/overview`, `/transactions`, `/budgets` and `/accounts` currently expose authenticated data views.

Imports commit each page and its cursor together; provider IDs are unique per item. Replays do not duplicate rows. Pending-to-posted imports preserve user/rule categories. Concurrent refreshes return 409, abandoned leases expire after 60 seconds, and each request starts pages for at most 20 seconds. Refreshes are capped at six per user per hour; users may have three items, 5,000 transactions and 200 rules. Amounts are integer cents, positive for inflow and negative for outflow. Cash-flow totals use posted USD transactions and exclude transfers.

Shared T2 helpers and tests were ported directly from `30-apps-template` main (`55a9cef`); the helper migration was regenerated in this repository before the domain migration. Template rate kinds remain for the ported tests; budgeting adds `sync`, `categorize`, `explain`, `rule_write`, and `demo_load`.

`POST /api/bank/items` accepts `{ "demo": true }`; sync at `POST /api/bank/items/:id/sync`, disconnect at `DELETE /api/bank/items/:id`. `GET /api/transactions` accepts `month`, `account`, `category`, `review=true`, and `cursor` (100 rows/page). `PATCH /api/transactions/:id` accepts `{ "categorySlug": "dining", "always": true }`. `GET/PUT /api/budgets` reads/replaces limits (`{ "budgets": [{ "categorySlug": "dining", "monthlyLimitCents": 25000 }] }`). `GET /api/cashflow?month=YYYY-MM` returns cents, category budgets/remaining/prior month, top merchants and counts. All mutations require a matching Origin. Admins can use `GET /api/admin/counts` and `POST /api/admin/demo`.

For local demo users, first create an admin with `pnpm db:seed`, then run:

```sh
DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD='<choose-a-local-password>' SEED_ADMIN_EMAIL=you@example.test pnpm seed:demo
```

The seed refuses production app/database hosts before loading database code. The live admin button uses a separate authorized loader. It creates `alex@demo.breakthru.test`, `blair@demo.breakthru.test` and `casey@demo.breakthru.test`, with 90 days of demo transactions and recurring budgets. Repeated loads replace only marked demo financial records and preserve existing credentials. Public signups cannot claim reserved demo identities. No bank secrets are stored for demo items.

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Next.js container ── pages, server actions, route handlers (/api/*)
   │                  auth + RBAC, zod validation, AI gateway, JSON logs, /api/health
   ├──► Postgres (Drizzle; pgvector available for RAG)
   └──► Model API (Gemini free tier, Claude optional, or recorded demo answers)
```

| Concern | Where |
| --- | --- |
| Config, validated at startup | `src/lib/env.ts` |
| Schema and migrations | `src/lib/db/schema.ts`, `drizzle/` |
| Sign-in, sessions, roles | `src/lib/auth/` (Better Auth + admin plugin) |
| Access rules | `src/lib/auth/rbac.ts`, enforced in every data function |
| AI gateway | `src/lib/ai/` — input cap, JSON schema validation, demo fallback |
| Health check | `GET /api/health` (503 if the database is down) |

## Auth and roles

Two roles, `user` and `admin`, via Better Auth's admin plugin. **Admins manage accounts but never act as users:**
`src/lib/auth/permissions.ts` gives `admin` create, list, get, update, set-role, ban and delete on users plus
session revoke/delete. It withholds `impersonate`, `impersonate-admins`, `set-password` and `set-email`
(Better Auth's default admin role includes them) and session `list`, which would expose other users' raw
session tokens, IP addresses and user agents. `/admin/impersonate-user`, `/admin/stop-impersonating`,
`/admin/set-user-password` and `/admin/list-user-sessions` are also in `disabledPaths`, so they return 404 even
if a role is widened later. `update` lets an admin change another user's name and image (intended).
Tests: `test/admin-permissions.integration.test.ts`. Don't add these permissions back; apps promise that admins
see counts only.

## Run locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev                             # http://localhost:3000
```

To make yourself an admin: sign up, then `SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed`
while the app is running.

## Design system

Every app shares the Breakthru look (guide and concept: `ai-dev-os/design/`). Tokens live in `src/app/globals.css`
(light and dark; use `bg-surface`, `text-muted`, `border-border`, `bg-accent` and the status tokens, never raw colors).
Fonts are self-hosted with `next/font/local` in `src/app/layout.tsx` (files and licenses in `src/app/fonts/`, so builds need no network): Newsreader (`font-display`), Public Sans (`font-sans`),
IBM Plex Mono (`font-mono`). Set the app's name once in `src/lib/app-config.ts` (`APP_TITLE`, or the `APP_NAME` variable).

| Component | Location | Use |
| --- | --- | --- |
| `AppShell` | `src/components/app-shell.tsx` | Header (logo, app name, nav, sign in or user and sign out) and footer; wraps every page in the root layout |
| `PageIntro` | `src/components/ui/` | Eyebrow, Newsreader headline, one-line description, actions |
| `StatTile`, `StatGrid` | `src/components/ui/` | A number and a label; tiles stack at 375px |
| `FilterBar` | `src/components/ui/` | Search, select filters, sort and table/cards toggle as a GET form (state in the URL) |
| `StatusBadge` | `src/components/ui/` | Live, building, blocked, not started (neutral), healthy, degraded, down |
| `DataList` | `src/components/ui/` | Table from 640px, cards below |
| `Panel` | `src/components/ui/` | Titled panel; `collapsible` adds a "Show all" toggle (small client component) |
| `DemoBadge` | `src/components/ui/` | "Demo data" label for seeded or demo content |

The header links come from `NAV_LINKS` in `src/lib/app-config.ts`.

Shared button and field classes are in `src/components/ui/styles.ts` (44px minimum height). Don't add `loading.tsx` or
`<Suspense>` above a page that calls `requireRoleOrRedirect()` or `notFound()`.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus data-layer tests against real Postgres
pnpm build && pnpm smoke                   # end-to-end smoke test against a running app
```

CI runs all of these plus both container builds on every pull request.

## Deploy

Every push to `main` publishes a multi-arch image (x86 and ARM) to GitHub Container Registry as
`ghcr.io/breakthrudevelopment/<repo>:sha-<commit>`. [30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra)
deploys those tags to AWS, Azure, Google Cloud and Oracle Cloud with Terraform; this repo holds no cloud credentials.

With `MIGRATE_ON_START=true` the server applies pending migrations before taking traffic, holding a Postgres
advisory lock so instances starting together can't race. `pnpm db:migrate` does the same by hand.

## Using the AI feature

| `AI_PROVIDER` | Behavior |
| --- | --- |
| `demo` (default) | Recorded answers from `src/lib/ai/demo.ts`; no key, no network |
| `gemini` | Google Gemini API (`GEMINI_API_KEY`, free tier) |
| `anthropic` | Claude (`ANTHROPIC_API_KEY`) |

With `AI_FALLBACK_TO_DEMO=true`, a quota error or outage serves the recorded answer and the UI says so.

### Budget AI guardrails

Two tasks go through `generate()`: `categorize-transactions` and `explain-cash-flow` (`src/lib/ai/budget-tasks.ts`, `src/lib/budget-ai.ts`). Merchant names are treated as data, outflows can never become income, and the explanation is labelled "AI summary, not financial advice".

- **The number check proves a figure exists in the data, not which category it belongs to.** Every dollar amount the model writes must match a figure the server computed (within $1), and percentages, ratios and spelled-out amounts are rejected. A model that attaches a real figure to the wrong category passes this check. The over-budget list is the only claim the server verifies against the data.
- The advice filter (`src/lib/advice-guardrails.ts`) is a broad keyword list. It reduces advice; it does not prove its absence.
- A summary is regenerated only when the user asks (`regenerate: true`, at most 2 per month); changed data just marks the cached text stale.

### Images: `generate({ images })`

`generate()` takes an optional `images: { mimeType, data }[]` (base64 of the raw bytes, no `data:` prefix). Limits
(`input_rejected`, checked before any network call, in every mode): at most 4 images, 5 MB each decoded
(`MAX_IMAGE_BYTES`), 10 MB in total, MIME `image/jpeg`, `image/png`, `image/webp`, `image/heic` or `image/heif`, valid
base64. Gemini gets one `inlineData` part per image before the text part; Anthropic gets `image` blocks and rejects
HEIC/HEIF. `demo` answers from the task's fixture and ignores the images. Logs carry the image count and total bytes,
never the data. Treat text inside an image as data in your system prompt, exactly like user text.

### Embeddings: `embed()`

`embed({ task, texts, kind: "document" | "query" })` from `src/lib/ai` returns
`{ vectors, provider, model, dims, demo, latencyMs }`: 768-dim, L2-normalized vectors (fits pgvector's 2,000-dim
HNSW limit). Limits: 32 texts per call, 8,000 characters each, 64,000 in total (`input_rejected`).

- `gemini` calls `batchEmbedContents` with `AI_EMBED_MODEL` (default `gemini-embedding-2`, which takes the task in
  the text: `task: search result | query: …` / `title: none | text: …`; set `gemini-embedding-001` to use `taskType`).
  Changing the model changes the vector space: stored vectors must be re-embedded.
- `demo` (and a missing key, or a provider failure while `AI_FALLBACK_TO_DEMO=true`) uses deterministic hashed
  bag-of-words vectors, model `demo-hash-768`: lexical but meaningful, offline.
- `AI_PROVIDER=anthropic` has no embeddings API, so it embeds with Gemini if `GEMINI_API_KEY` is set, else demo.
- Always store `model` with each vector and only compare vectors with the same model; a demo fallback reports
  `demo: true` and the demo model name so vector spaces are never mixed.
- `AI_TIMEOUT_MS` (default 20000, max 22000) bounds every provider call, `generate()` and `embed()` alike.
- Logs carry task, provider, model, count and latency, never the text.
