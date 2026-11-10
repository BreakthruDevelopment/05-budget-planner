CREATE TABLE "bank_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"name" varchar(80) NOT NULL,
	"mask" char(4) NOT NULL,
	"type" text NOT NULL,
	"subtype" text NOT NULL,
	"current_cents" bigint NOT NULL,
	"available_cents" bigint,
	CONSTRAINT "bank_account_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "bank_account_item_owner_unique" UNIQUE("id","item_id","owner_id"),
	CONSTRAINT "bank_account_provider_unique" UNIQUE("item_id","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "bank_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_item_id" text NOT NULL,
	"institution_name" varchar(80) NOT NULL,
	"cursor" text,
	"status" text DEFAULT 'active' NOT NULL,
	"syncing_since" timestamp (3) with time zone,
	"last_synced_at" timestamp (3) with time zone,
	CONSTRAINT "bank_item_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "bank_item_provider_unique" UNIQUE("provider","provider_item_id"),
	CONSTRAINT "bank_item_provider_chk" CHECK ("bank_item"."provider" in ('demo','plaid')),
	CONSTRAINT "bank_item_status_chk" CHECK ("bank_item"."status" in ('active','login_required','error'))
);
--> statement-breakpoint
CREATE TABLE "bank_item_secret" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"blob" "bytea" NOT NULL,
	"kid" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget" (
	"owner_id" text NOT NULL,
	"category_slug" text NOT NULL,
	"monthly_limit_cents" integer NOT NULL,
	CONSTRAINT "budget_owner_id_category_slug_pk" PRIMARY KEY("owner_id","category_slug"),
	CONSTRAINT "budget_limit_chk" CHECK ("budget"."monthly_limit_cents" between 1 and 10000000)
);
--> statement-breakpoint
CREATE TABLE "cashflow_summary" (
	"owner_id" text NOT NULL,
	"month" char(7) NOT NULL,
	"data" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"mode" text NOT NULL,
	"input_hash" text NOT NULL,
	"regenerations" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cashflow_summary_owner_id_month_pk" PRIMARY KEY("owner_id","month")
);
--> statement-breakpoint
CREATE TABLE "category" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "category_kind_chk" CHECK ("category"."kind" in ('income','expense','transfer'))
);
--> statement-breakpoint
CREATE TABLE "category_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"merchant_key" varchar(120) NOT NULL,
	"category_slug" text NOT NULL,
	CONSTRAINT "category_rule_merchant_unique" UNIQUE("owner_id","merchant_key")
);
--> statement-breakpoint
CREATE TABLE "txn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"provider_txn_id" text NOT NULL,
	"pending_txn_id" text,
	"date" date NOT NULL,
	"name" varchar(200) NOT NULL,
	"merchant_name" varchar(120),
	"merchant_key" varchar(120) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"iso_currency" text NOT NULL,
	"pending" boolean NOT NULL,
	"provider_category" varchar(64),
	"category_slug" text,
	"category_source" text DEFAULT 'none' NOT NULL,
	"ai_confidence" numeric(3, 2),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "txn_provider_unique" UNIQUE("item_id","provider_txn_id"),
	CONSTRAINT "txn_category_source_chk" CHECK ("txn"."category_source" in ('user','rule','provider','ai','none'))
);
--> statement-breakpoint
ALTER TABLE "item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "daily_usage" DROP CONSTRAINT "daily_usage_kind_chk";--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_item_id_owner_id_bank_item_id_owner_id_fk" FOREIGN KEY ("item_id","owner_id") REFERENCES "public"."bank_item"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_item" ADD CONSTRAINT "bank_item_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_item_secret" ADD CONSTRAINT "bank_item_secret_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_item_secret" ADD CONSTRAINT "bank_item_secret_item_id_owner_id_bank_item_id_owner_id_fk" FOREIGN KEY ("item_id","owner_id") REFERENCES "public"."bank_item"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_category_slug_category_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."category"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashflow_summary" ADD CONSTRAINT "cashflow_summary_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rule" ADD CONSTRAINT "category_rule_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rule" ADD CONSTRAINT "category_rule_category_slug_category_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."category"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txn" ADD CONSTRAINT "txn_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txn" ADD CONSTRAINT "txn_category_slug_category_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."category"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txn" ADD CONSTRAINT "txn_account_id_item_id_owner_id_bank_account_id_item_id_owner_id_fk" FOREIGN KEY ("account_id","item_id","owner_id") REFERENCES "public"."bank_account"("id","item_id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "txn_owner_date_idx" ON "txn" USING btree ("owner_id","date" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "txn_owner_category_date_idx" ON "txn" USING btree ("owner_id","category_slug","date");--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_kind_chk" CHECK ("daily_usage"."kind" in ('ai', 'demo_load', 'categorize', 'explain'));--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('api_write', 'ai', 'upload', 'sync', 'categorize', 'explain', 'rule_write', 'demo_load'));--> statement-breakpoint
INSERT INTO category (slug, name, kind, position) VALUES
('income','Income','income',0),('housing','Housing','expense',1),('groceries','Groceries','expense',2),
('dining','Dining','expense',3),('transport','Transport','expense',4),('utilities','Utilities','expense',5),
('shopping','Shopping','expense',6),('health','Health','expense',7),('entertainment','Entertainment','expense',8),
('travel','Travel','expense',9),('subscriptions','Subscriptions','expense',10),('fees','Fees','expense',11),
('transfer','Transfer','transfer',12),('other','Other','expense',13);
