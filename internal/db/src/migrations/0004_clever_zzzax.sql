CREATE TYPE "public"."ledger_entry_type" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."ledger_settlement_type" AS ENUM('invoice', 'manual');--> statement-breakpoint
CREATE TABLE "unprice_ledger_entries" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"ledger_id" varchar(36) NOT NULL,
	"customer_id" varchar(36) NOT NULL,
	"currency" "currency" NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"amount_cents" integer NOT NULL,
	"signed_amount_cents" integer NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"source_id" varchar(160) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"description" varchar(255),
	"statement_key" varchar(64),
	"subscription_id" varchar(36),
	"subscription_phase_id" varchar(36),
	"subscription_item_id" varchar(36),
	"billing_period_id" varchar(36),
	"feature_plan_version_id" varchar(36),
	"invoice_item_kind" "invoice_item_kind" DEFAULT 'period' NOT NULL,
	"cycle_start_at_m" bigint,
	"cycle_end_at_m" bigint,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_cents" integer,
	"amount_subtotal_cents" integer DEFAULT 0 NOT NULL,
	"amount_total_cents" integer DEFAULT 0 NOT NULL,
	"balance_after_cents" integer DEFAULT 0 NOT NULL,
	"settlement_type" "ledger_settlement_type",
	"settlement_artifact_id" text,
	"settlement_pending_provider_confirmation" boolean DEFAULT false NOT NULL,
	"settled_at_m" bigint,
	"metadata" json,
	CONSTRAINT "ledger_entries_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_ledgers" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customer_id" varchar(36) NOT NULL,
	"currency" "currency" NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"unsettled_balance_cents" integer DEFAULT 0 NOT NULL,
	"last_entry_at_m" bigint,
	CONSTRAINT "ledgers_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ALTER COLUMN "payment_provider" SET DEFAULT 'sandbox';--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD CONSTRAINT "unprice_ledger_entries_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD CONSTRAINT "ledger_entries_ledger_id_fkey" FOREIGN KEY ("ledger_id","project_id") REFERENCES "public"."unprice_ledgers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD CONSTRAINT "ledger_entries_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD CONSTRAINT "ledger_entries_subscription_id_fkey" FOREIGN KEY ("subscription_id","project_id") REFERENCES "public"."unprice_subscriptions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD CONSTRAINT "ledger_entries_subscription_phase_id_fkey" FOREIGN KEY ("subscription_phase_id","project_id") REFERENCES "public"."unprice_subscription_phases"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD CONSTRAINT "ledger_entries_subscription_item_id_fkey" FOREIGN KEY ("subscription_item_id","project_id") REFERENCES "public"."unprice_subscription_items"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD CONSTRAINT "ledger_entries_billing_period_id_fkey" FOREIGN KEY ("billing_period_id","project_id") REFERENCES "public"."unprice_billing_periods"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD CONSTRAINT "ledger_entries_feature_plan_version_id_fkey" FOREIGN KEY ("feature_plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions_features"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD CONSTRAINT "ledger_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledgers" ADD CONSTRAINT "unprice_ledgers_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledgers" ADD CONSTRAINT "ledgers_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledgers" ADD CONSTRAINT "ledgers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_source_identity_uq" ON "unprice_ledger_entries" USING btree ("project_id","ledger_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_idempotency_uq" ON "unprice_ledger_entries" USING btree ("project_id","ledger_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_entries_unsettled_idx" ON "unprice_ledger_entries" USING btree ("project_id","ledger_id","statement_key","created_at_m") WHERE "unprice_ledger_entries"."settled_at_m" IS NULL;--> statement-breakpoint
CREATE INDEX "ledger_entries_statement_idx" ON "unprice_ledger_entries" USING btree ("project_id","subscription_id","statement_key");--> statement-breakpoint
CREATE INDEX "ledger_entries_settlement_artifact_idx" ON "unprice_ledger_entries" USING btree ("project_id","settlement_type","settlement_artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledgers_customer_currency_uq" ON "unprice_ledgers" USING btree ("project_id","customer_id","currency");--> statement-breakpoint
CREATE INDEX "ledgers_customer_idx" ON "unprice_ledgers" USING btree ("project_id","customer_id");