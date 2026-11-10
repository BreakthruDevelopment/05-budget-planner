#!/usr/bin/env bash
# HTTP smoke against a running app, exercising the demo bank without external services.
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; BODY="$(mktemp)"; FLOW="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$BODY" "$FLOW"' EXIT
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v[k];if(v===undefined)process.exit(1);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
health=$(curl -fsS "$BASE_URL/api/health") || fail "health unreachable"
[ "$(echo "$health" | field status)" = ok ] || fail "health degraded"
[ "$(echo "$health" | field bank)" = demo ] || fail "expected demo provider"
pass "health reports demo bank"
for path in / /sign-in; do
  curl -fsS "$BASE_URL$path" > "$BODY" || fail "page $path failed"
  grep -q 'Explore breakthruventures.ai' "$BODY" || fail "missing shared footer"
done
for path in /overview /transactions /budgets /accounts /admin; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = 307 ] || fail "anonymous $path: $code"
done
pass "public pages render; private pages redirect"
signup() {
  curl -fsS -c "$1" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"email\":\"$2\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "signup failed"
}
signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "A and B signed up"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/transactions")
[ "$code" = 401 ] || fail "anonymous transactions: $code"
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'origin: https://sibling.breakthruventures.ai' -H 'content-type: application/json' -d '{"demo":true}' "$BASE_URL/api/bank/items")
[ "$code" = 403 ] || fail "cross-origin connect: $code"
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR_A" -H "origin: $BASE_URL" -H 'content-type: application/json' --data-binary "$(node -e 'console.log(JSON.stringify({padding:"x".repeat(17000)}))')" "$BASE_URL/api/bank/items")
[ "$code" = 413 ] || fail "large body: $code"
pass "anonymous, cross-origin and oversized requests refused"
connected=$(curl -fsS -b "$JAR_A" -H "origin: $BASE_URL" -H 'content-type: application/json' -d '{"demo":true}' "$BASE_URL/api/bank/items") || fail "demo connect"
item_id=$(echo "$connected" | field item.id)
items=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/bank/items")
account_id=$(echo "$items" | field 0.accounts.0.id)
count_txns() {
  local cursor="" count=0 response n
  while :; do
    response=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/transactions${cursor:+?cursor=$cursor}") || fail "list transactions"
    n=$(echo "$response" | field items.length); count=$((count+n))
    cursor=$(echo "$response" | field nextCursor)
    [ "$cursor" != null ] || break
  done
  echo "$count"
}
initial=$(count_txns)
[ "$initial" = 149 ] || fail "demo row count: $initial"
for _ in 1 2; do
  curl -fsS -b "$JAR_A" -X POST -H "origin: $BASE_URL" "$BASE_URL/api/bank/items/$item_id/sync" > /dev/null || fail "sync"
  [ "$(count_txns)" = "$initial" ] || fail "sync duplicated rows"
done
pass "demo connect and two syncs keep 149 rows"
txns=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/transactions")
txn_id=$(echo "$txns" | field items.0.id)
for path in "/api/transactions/$txn_id" "/api/bank/items/$item_id" "/api/transactions?account=$account_id"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR_B" "$BASE_URL$path")
  [ "$code" = 404 ] || fail "B reading A: $code"
done
for spec in "PATCH /api/transactions/$txn_id" "DELETE /api/bank/items/$item_id" "POST /api/bank/items/$item_id/sync"; do
  read -r method path <<< "$spec"
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X "$method" -b "$JAR_B" -H "origin: $BASE_URL" -H 'content-type: application/json' -d '{"categorySlug":"dining"}' "$BASE_URL$path")
  [ "$code" = 404 ] || fail "B mutating A: $code"
done
pass "B receives 404 for A's financial records"
updated=$(curl -fsS -X PATCH -b "$JAR_A" -H "origin: $BASE_URL" -H 'content-type: application/json' -d '{"categorySlug":"dining","always":true}' "$BASE_URL/api/transactions/$txn_id")
[ "$(echo "$updated" | field categorySource)" = user ] || fail "recategorize"
rules=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/rules")
[ "$(echo "$rules" | field 0.categorySlug)" = dining ] || fail "always rule missing"
curl -fsS -X PUT -b "$JAR_A" -H "origin: $BASE_URL" -H 'content-type: application/json' -d '{"budgets":[{"categorySlug":"dining","monthlyLimitCents":25000}]}' "$BASE_URL/api/budgets" > /dev/null
limits=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/budgets")
[ "$(echo "$limits" | field 0.monthlyLimitCents)" = 25000 ] || fail "budget read"
flow=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/cashflow")
echo "$flow" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s);if(!/^\d{4}-\d{2}$/.test(f.month)||![f.incomeCents,f.spendCents,f.netCents,f.counts.transactions].every(Number.isSafeInteger)||!Array.isArray(f.categories)||!Array.isArray(f.topMerchants)||f.netCents!==f.incomeCents-f.spendCents)process.exit(1)})' || fail "cashflow shape"
pass "recategorize always, budgets and cashflow"
ai=$(curl -fsS -X POST -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/ai/categorize") || fail "ai categorize"
echo "$ai" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!Number.isInteger(r.sent)||!Number.isInteger(r.applied)||!Number.isInteger(r.suggested)||r.suggested<0||typeof r.demo!=="boolean"||!/not financial advice/.test(r.disclaimer))process.exit(1)})' || fail "ai categorize shape"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H 'origin: https://sibling.breakthruventures.ai' "$BASE_URL/api/ai/categorize")
[ "$code" = 403 ] || fail "cross-origin ai categorize: $code"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/ai/categorize")
[ "$code" = 401 ] || fail "anonymous ai categorize: $code"
explain_month=$(node -e 'console.log(new Date().toISOString().slice(0,7))')
explain_body="{\"month\":\"$explain_month\"}"
first=$(curl -fsS -X POST -b "$JAR_A" -H "origin: $BASE_URL" -H 'content-type: application/json' -d "$explain_body" "$BASE_URL/api/ai/cashflow") || fail "ai cashflow"
second=$(curl -fsS -X POST -b "$JAR_A" -H "origin: $BASE_URL" -H 'content-type: application/json' -d "$explain_body" "$BASE_URL/api/ai/cashflow") || fail "ai cashflow again"
[ "$(echo "$first" | field explanation.generatedAt)" = "$(echo "$second" | field explanation.generatedAt)" ] || fail "unchanged data regenerated the summary"
[ "$(echo "$first" | field explanation.disclaimer)" = "AI summary, not financial advice" ] || fail "ai disclaimer"
cached=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/ai/cashflow?month=$explain_month")
[ "$(echo "$cached" | field explanation.generatedAt)" = "$(echo "$first" | field explanation.generatedAt)" ] || fail "cached summary missing"
cached_b=$(curl -fsS -b "$JAR_B" "$BASE_URL/api/ai/cashflow?month=$explain_month")
[ "$(echo "$cached_b" | field explanation)" = null ] || fail "B can see A's summary"
pass "AI categorize and cash-flow summary (cached on unchanged data, private per user)"
flow=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/cashflow?month=$explain_month") || fail "cashflow for pages"
echo "$flow" > "$FLOW"
curl -fsS -b "$JAR_A" "$BASE_URL/overview?month=$explain_month" > "$BODY" || fail "overview page"
grep -q 'Explore breakthruventures.ai' "$BODY" || fail "overview missing footer"
grep -q 'Update summary' "$BODY" || fail "overview missing update summary"
grep -q 'AI summary, not financial advice' "$BODY" || fail "overview missing disclaimer"
headline=$(echo "$first" | field explanation.data.headline)
grep -q -F "$headline" "$BODY" || fail "overview missing summary headline"
node -e '
const fs = require("fs");
const html = fs.readFileSync(process.argv[1], "utf8");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const attr = (name) => {
  const match = html.match(new RegExp("data-" + name + "=\"(-?[0-9]+)\""));
  if (!match) { console.error("missing data-" + name); process.exit(1); }
  return match[1];
};
for (const [name, value] of [["income-cents", flow.incomeCents], ["spend-cents", flow.spendCents], ["net-cents", flow.netCents], ["needs-review", flow.counts.needsReview]]) {
  if (attr(name) !== String(value)) { console.error(name + " page " + attr(name) + " api " + value); process.exit(1); }
}
' "$BODY" "$FLOW" || fail "overview numbers differ from the API"
curl -fsS -b "$JAR_A" "$BASE_URL/budgets?month=$explain_month" > "$BODY" || fail "budgets page"
node -e '
const fs = require("fs");
const html = fs.readFileSync(process.argv[1], "utf8");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dining = flow.categories.find((row) => row.categorySlug === "dining");
if (!dining) { console.error("dining missing from cashflow"); process.exit(1); }
const slice = html.split("data-category=\"dining\"")[1] || "";
const spend = slice.match(/data-spend-cents="(-?\d+)"/);
const limit = slice.match(/data-limit-cents="(\d+)"/);
if (!spend || spend[1] !== String(dining.spendCents)) { console.error("dining spend"); process.exit(1); }
if (!limit || limit[1] !== "25000") { console.error("dining limit"); process.exit(1); }
' "$BODY" "$FLOW" || fail "budget page numbers differ from the API"
txns=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/transactions?month=$explain_month") || fail "transactions for pages"
echo "$txns" > "$FLOW"
curl -fsS -b "$JAR_A" "$BASE_URL/transactions?month=$explain_month" > "$BODY" || fail "transactions page"
node -e '
const fs = require("fs");
const html = fs.readFileSync(process.argv[1], "utf8");
const tx = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const row = tx.items && tx.items[0];
if (!row) { console.error("no transactions"); process.exit(1); }
const name = row.merchantName || row.name;
if (!html.includes(name)) { console.error("page missing " + name); process.exit(1); }
' "$BODY" "$FLOW" || fail "transactions page missing the API row"
review=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/transactions?review=true") || fail "review list"
echo "$review" > "$FLOW"
curl -fsS -b "$JAR_A" "$BASE_URL/transactions?month=all&review=true" > "$BODY" || fail "review page"
node -e '
const fs = require("fs");
const html = fs.readFileSync(process.argv[1], "utf8");
const tx = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const names = { income: "Income", housing: "Housing", groceries: "Groceries", dining: "Dining", transport: "Transport", utilities: "Utilities", shopping: "Shopping", health: "Health", entertainment: "Entertainment", travel: "Travel", subscriptions: "Subscriptions", fees: "Fees", transfer: "Transfer", other: "Other" };
if (!Array.isArray(tx.items)) { console.error("review list"); process.exit(1); }
if (tx.items.length === 0) {
  if (!html.includes("Nothing needs review.")) { console.error("empty review"); process.exit(1); }
  process.exit(0);
}
for (const row of tx.items) {
  const label = row.merchantName || row.name;
  if (!html.includes(label)) { console.error("review missing " + label); process.exit(1); }
  const confidence = row.aiConfidence == null ? null : Number(row.aiConfidence);
  if (row.categorySource === "ai" && confidence != null && confidence < 0.6 && row.categorySlug) {
    const chip = "Suggested: " + (names[row.categorySlug] || row.categorySlug);
    if (!html.includes(chip)) { console.error("missing " + chip); process.exit(1); }
  }
}
' "$BODY" "$FLOW" || fail "review page differs from the API"
items=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/bank/items") || fail "items for pages"
echo "$items" > "$FLOW"
curl -fsS -b "$JAR_A" "$BASE_URL/accounts" > "$BODY" || fail "accounts page"
node -e '
const fs = require("fs");
const html = fs.readFileSync(process.argv[1], "utf8");
const items = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!html.includes("data-bank=\"demo\"")) { console.error("bank mode"); process.exit(1); }
if (!html.includes("Connect demo bank")) { console.error("demo connect"); process.exit(1); }
if (!items[0] || !html.includes(items[0].institutionName)) { console.error("institution"); process.exit(1); }
for (const account of items.flatMap((item) => item.accounts)) {
  if (!html.includes("data-balance-cents=\"" + account.currentCents + "\"")) { console.error("balance " + account.currentCents); process.exit(1); }
}
' "$BODY" "$FLOW" || fail "accounts page differs from the API"
curl -fsS -b "$JAR_A" "$BASE_URL/overview" > "$BODY" || fail "overview without month"
grep -q "Loading this month" "$BODY" || fail "overview should wait for the browser month"
code=$(curl -sS -o "$BODY" -w '%{http_code}' -b "$JAR_A" "$BASE_URL/overview?month=1999-01")
[ "$code" = 200 ] || fail "invalid month status: $code"
grep -q 'role="alert"' "$BODY" || fail "invalid month missing alert"
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR_A" "$BASE_URL/admin")
[ "$code" = 307 ] || fail "non-admin admin page: $code"
pass "pages render API numbers, suggestion chips, and the demo connect button"
for path in /overview /transactions /budgets /accounts; do
  curl -fsS -b "$JAR_A" "$BASE_URL$path" > /dev/null || fail "signed-in page $path"
done
code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/bank/items/$item_id")
[ "$code" = 204 ] || fail "disconnect: $code"
[ "$(count_txns)" = 0 ] || fail "disconnect did not cascade"
pass "owner disconnect deletes imported records"
echo "SMOKE PASS"
