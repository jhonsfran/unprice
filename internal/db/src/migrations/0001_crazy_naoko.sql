CREATE TYPE "public"."wallet_grant_source" AS ENUM('promo', 'plan_included', 'trial', 'manual');--> statement-breakpoint
CREATE TYPE "public"."wallet_topup_status" AS ENUM('pending', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "unprice_entitlement_reservations" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"entitlement_id" varchar(36) COLLATE "C" NOT NULL,
	"allocation_amount" bigint NOT NULL,
	"consumed_amount" bigint DEFAULT 0 NOT NULL,
	"refill_threshold_bps" integer DEFAULT 2000 NOT NULL,
	"refill_chunk_amount" bigint NOT NULL,
	"period_start_at" timestamp with time zone NOT NULL,
	"period_end_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "entitlement_reservations_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_wallet_topups" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"provider" text NOT NULL,
	"provider_session_id" text NOT NULL,
	"requested_amount" bigint NOT NULL,
	"currency" "currency" NOT NULL,
	"status" "wallet_topup_status" NOT NULL,
	"settled_amount" bigint,
	"ledger_transfer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "wallet_topups_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_wallet_grants" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"source" "wallet_grant_source" NOT NULL,
	"issued_amount" bigint NOT NULL,
	"remaining_amount" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"ledger_transfer_id" text NOT NULL,
	"metadata" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_grants_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
DROP TABLE "unprice_credit_grants" CASCADE;--> statement-breakpoint
DROP TABLE "unprice_invoice_credit_applications" CASCADE;--> statement-breakpoint
DROP TABLE "unprice_invoice_items" CASCADE;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD COLUMN "total_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" ADD CONSTRAINT "unprice_entitlement_reservations_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" ADD CONSTRAINT "entitlement_reservations_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" ADD CONSTRAINT "entitlement_reservations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_topups" ADD CONSTRAINT "unprice_wallet_topups_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_topups" ADD CONSTRAINT "wallet_topups_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_topups" ADD CONSTRAINT "wallet_topups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_grants" ADD CONSTRAINT "unprice_wallet_grants_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_grants" ADD CONSTRAINT "wallet_grants_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_wallet_grants" ADD CONSTRAINT "wallet_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_reservations_entitlement_period_idx" ON "unprice_entitlement_reservations" USING btree ("project_id","entitlement_id","period_start_at");--> statement-breakpoint
CREATE INDEX "entitlement_reservations_customer_idx" ON "unprice_entitlement_reservations" USING btree ("project_id","customer_id");--> statement-breakpoint
CREATE INDEX "entitlement_reservations_active_period_end_idx" ON "unprice_entitlement_reservations" USING btree ("period_end_at") WHERE "unprice_entitlement_reservations"."reconciled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_topups_provider_session_idx" ON "unprice_wallet_topups" USING btree ("provider","provider_session_id");--> statement-breakpoint
CREATE INDEX "wallet_topups_customer_created_idx" ON "unprice_wallet_topups" USING btree ("project_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_topups_pending_sweep_idx" ON "unprice_wallet_topups" USING btree ("created_at") WHERE "unprice_wallet_topups"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_grants_ledger_transfer_idx" ON "unprice_wallet_grants" USING btree ("customer_id","ledger_transfer_id");--> statement-breakpoint
CREATE INDEX "wallet_grants_active_customer_expiry_idx" ON "unprice_wallet_grants" USING btree ("customer_id","expires_at") WHERE "unprice_wallet_grants"."expired_at" IS NULL AND "unprice_wallet_grants"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "wallet_grants_expiration_sweep_idx" ON "unprice_wallet_grants" USING btree ("expires_at") WHERE "unprice_wallet_grants"."expired_at" IS NULL AND "unprice_wallet_grants"."voided_at" IS NULL AND "unprice_wallet_grants"."remaining_amount" > 0;--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "payment_attempts";--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "amount_credit_used";--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "subtotal_cents";--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "total_cents";--> statement-breakpoint
DROP TYPE "public"."invoice_item_kind";