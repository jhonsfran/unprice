ALTER TYPE "public"."ledger_settlement_type" ADD VALUE 'wallet';--> statement-breakpoint
ALTER TYPE "public"."ledger_settlement_type" ADD VALUE 'one_time';--> statement-breakpoint
CREATE TABLE "unprice_ledger_settlement_lines" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"settlement_id" varchar(36) COLLATE "C" NOT NULL,
	"ledger_entry_id" varchar(36) COLLATE "C" NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "ledger_settlement_lines_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_ledger_settlements" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"ledger_id" varchar(36) COLLATE "C" NOT NULL,
	"type" varchar(32) NOT NULL,
	"artifact_id" varchar(160) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"reverses_settlement_id" varchar(36) COLLATE "C",
	"confirmed_at_m" bigint,
	"reversed_at_m" bigint,
	"reversal_reason" varchar(255),
	"metadata" json,
	CONSTRAINT "ledger_settlements_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP CONSTRAINT "ledger_entries_subscription_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP CONSTRAINT "ledger_entries_subscription_phase_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP CONSTRAINT "ledger_entries_subscription_item_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP CONSTRAINT "ledger_entries_billing_period_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP CONSTRAINT "ledger_entries_feature_plan_version_id_fkey";
--> statement-breakpoint
DROP INDEX "ledger_entries_unsettled_idx";--> statement-breakpoint
DROP INDEX "ledger_entries_settlement_artifact_idx";--> statement-breakpoint
DROP INDEX "ledger_entries_statement_idx";--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD COLUMN "ledger_entry_id" varchar(36) COLLATE "C";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD COLUMN "amount_minor" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD COLUMN "signed_amount_minor" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD COLUMN "balance_after_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" ADD COLUMN "journal_id" varchar(64);--> statement-breakpoint
ALTER TABLE "unprice_ledgers" ADD COLUMN "balance_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_ledger_settlement_lines" ADD CONSTRAINT "unprice_ledger_settlement_lines_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_settlement_lines" ADD CONSTRAINT "ledger_settlement_lines_settlement_id_fkey" FOREIGN KEY ("settlement_id","project_id") REFERENCES "public"."unprice_ledger_settlements"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_settlement_lines" ADD CONSTRAINT "ledger_settlement_lines_entry_id_fkey" FOREIGN KEY ("ledger_entry_id","project_id") REFERENCES "public"."unprice_ledger_entries"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_settlement_lines" ADD CONSTRAINT "ledger_settlement_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_settlements" ADD CONSTRAINT "unprice_ledger_settlements_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_settlements" ADD CONSTRAINT "ledger_settlements_ledger_id_fkey" FOREIGN KEY ("ledger_id","project_id") REFERENCES "public"."unprice_ledgers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_ledger_settlements" ADD CONSTRAINT "ledger_settlements_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_settlement_lines_uq" ON "unprice_ledger_settlement_lines" USING btree ("project_id","settlement_id","ledger_entry_id");--> statement-breakpoint
CREATE INDEX "ledger_settlement_lines_entry_idx" ON "unprice_ledger_settlement_lines" USING btree ("project_id","ledger_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_settlements_artifact_uq" ON "unprice_ledger_settlements" USING btree ("project_id","ledger_id","artifact_id","type");--> statement-breakpoint
CREATE INDEX "ledger_settlements_artifact_idx" ON "unprice_ledger_settlements" USING btree ("project_id","type","artifact_id");--> statement-breakpoint
CREATE INDEX "ledger_settlements_status_idx" ON "unprice_ledger_settlements" USING btree ("project_id","ledger_id","status");--> statement-breakpoint
ALTER TABLE "unprice_invoice_items" ADD CONSTRAINT "invoice_items_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id","project_id") REFERENCES "public"."unprice_ledger_entries"("id","project_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_idx" ON "unprice_ledger_entries" USING btree ("project_id","journal_id") WHERE "unprice_ledger_entries"."journal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_entries_statement_idx" ON "unprice_ledger_entries" USING btree ("project_id","statement_key");--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "amount_cents";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "signed_amount_cents";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "subscription_id";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "subscription_phase_id";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "subscription_item_id";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "billing_period_id";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "feature_plan_version_id";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "invoice_item_kind";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "cycle_start_at_m";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "cycle_end_at_m";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "quantity";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "unit_amount_cents";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "amount_subtotal_cents";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "amount_total_cents";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "balance_after_cents";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "settlement_type";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "settlement_artifact_id";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "settlement_pending_provider_confirmation";--> statement-breakpoint
ALTER TABLE "unprice_ledger_entries" DROP COLUMN "settled_at_m";--> statement-breakpoint
ALTER TABLE "unprice_ledgers" DROP COLUMN "balance_cents";--> statement-breakpoint
ALTER TABLE "unprice_ledgers" DROP COLUMN "unsettled_balance_cents";