import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, customType, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["api_write", "ai", "upload", "sync", "categorize", "explain", "rule_write", "demo_load", "link_token", "exchange"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load", "categorize", "explain"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export type User = typeof user.$inferSelect;


export const SLUGS = ["income", "housing", "groceries", "dining", "transport", "utilities", "shopping", "health", "entertainment", "travel", "subscriptions", "fees", "transfer", "other"] as const;
export const category = pgTable("category", {
  slug: text("slug").primaryKey(), name: text("name").notNull(),
  kind: text("kind", { enum: ["income", "expense", "transfer"] }).notNull(), position: integer("position").notNull(),
}, t => [check("category_kind_chk", sql`${t.kind} in ('income','expense','transfer')`)]);
const owner = () => text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" });
const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
export const bankItem = pgTable("bank_item", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: owner(),
  provider: text("provider", { enum: ["demo", "plaid"] }).notNull(), providerItemId: text("provider_item_id").notNull(),
  institutionName: varchar("institution_name", { length: 80 }).notNull(), cursor: text("cursor"),
  status: text("status", { enum: ["active", "login_required", "error"] }).notNull().default("active"),
  syncingSince: instant("syncing_since"), lastSyncedAt: instant("last_synced_at"),
}, t => [unique("bank_item_owner_unique").on(t.id, t.ownerId), unique("bank_item_provider_unique").on(t.provider, t.providerItemId),
  check("bank_item_provider_chk", sql`${t.provider} in ('demo','plaid')`), check("bank_item_status_chk", sql`${t.status} in ('active','login_required','error')`)]);
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const bankItemSecret = pgTable("bank_item_secret", {
  itemId: uuid("item_id").primaryKey(), ownerId: owner(), blob: bytea("blob").notNull(), kid: text("kid").notNull(), createdAt: instant("created_at").notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.itemId, t.ownerId], foreignColumns: [bankItem.id, bankItem.ownerId] }).onDelete("cascade")]);
export const bankAccount = pgTable("bank_account", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: owner(), itemId: uuid("item_id").notNull(), providerAccountId: text("provider_account_id").notNull(),
  name: varchar("name", { length: 80 }).notNull(), mask: char("mask", { length: 4 }).notNull(), type: text("type").notNull(), subtype: text("subtype").notNull(),
  currentCents: bigint("current_cents", { mode: "number" }).notNull(), availableCents: bigint("available_cents", { mode: "number" }),
}, t => [unique("bank_account_owner_unique").on(t.id, t.ownerId), unique("bank_account_item_owner_unique").on(t.id, t.itemId, t.ownerId), unique("bank_account_provider_unique").on(t.itemId, t.providerAccountId), foreignKey({ columns: [t.itemId, t.ownerId], foreignColumns: [bankItem.id, bankItem.ownerId] }).onDelete("cascade")]);
export const txn = pgTable("txn", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: owner(), accountId: uuid("account_id").notNull(), itemId: uuid("item_id").notNull(),
  providerTxnId: text("provider_txn_id").notNull(), pendingTxnId: text("pending_txn_id"), date: date("date", { mode: "string" }).notNull(),
  name: varchar("name", { length: 200 }).notNull(), merchantName: varchar("merchant_name", { length: 120 }), merchantKey: varchar("merchant_key", { length: 120 }).notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(), isoCurrency: text("iso_currency").notNull(), pending: boolean("pending").notNull(),
  providerCategory: varchar("provider_category", { length: 64 }), categorySlug: text("category_slug").references(() => category.slug),
  categorySource: text("category_source", { enum: ["user", "rule", "provider", "ai", "none"] }).notNull().default("none"), aiConfidence: numeric("ai_confidence", { precision: 3, scale: 2 }), aiSuggestedAt: instant("ai_suggested_at"),
  createdAt: instant("created_at").notNull().defaultNow(), updatedAt: instant("updated_at").notNull().defaultNow(),
}, t => [unique("txn_provider_unique").on(t.itemId, t.providerTxnId), foreignKey({ columns: [t.accountId, t.itemId, t.ownerId], foreignColumns: [bankAccount.id, bankAccount.itemId, bankAccount.ownerId] }).onDelete("cascade"),
  index("txn_owner_date_idx").on(t.ownerId, t.date.desc(), t.id.desc()), index("txn_owner_category_date_idx").on(t.ownerId, t.categorySlug, t.date),
  check("txn_category_source_chk", sql`${t.categorySource} in ('user','rule','provider','ai','none')`)]);
export const categoryRule = pgTable("category_rule", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: owner(), merchantKey: varchar("merchant_key", { length: 120 }).notNull(), categorySlug: text("category_slug").notNull().references(() => category.slug),
}, t => [unique("category_rule_merchant_unique").on(t.ownerId, t.merchantKey)]);
export const budget = pgTable("budget", {
  ownerId: owner(), categorySlug: text("category_slug").notNull().references(() => category.slug), monthlyLimitCents: integer("monthly_limit_cents").notNull(),
}, t => [primaryKey({ columns: [t.ownerId, t.categorySlug] }), check("budget_limit_chk", sql`${t.monthlyLimitCents} between 1 and 10000000`)]);
export const cashflowSummary = pgTable("cashflow_summary", {
  ownerId: owner(), month: char("month", { length: 7 }).notNull(), data: jsonb("data").notNull(), stats: jsonb("stats").notNull(), mode: text("mode").notNull(), inputHash: text("input_hash").notNull(), regenerations: integer("regenerations").notNull().default(0), generatedAt: instant("generated_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.ownerId, t.month] })]);
