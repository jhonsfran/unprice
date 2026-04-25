ALTER TYPE "public"."subscription_status_v3" ADD VALUE 'pending_payment' BEFORE 'canceled';--> statement-breakpoint
ALTER TYPE "public"."wallet_grant_source" ADD VALUE 'credit_line';--> statement-breakpoint
ALTER TABLE "unprice_plan_versions" ADD COLUMN "credit_line_amount" bigint DEFAULT 0 NOT NULL;