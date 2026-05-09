CREATE TYPE "public"."credit_line_policy" AS ENUM('capped', 'uncapped');--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ADD COLUMN "credit_line_policy" "credit_line_policy" DEFAULT 'capped' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ADD COLUMN "credit_line_amount" bigint;--> statement-breakpoint
ALTER TABLE "unprice_plan_versions" DROP COLUMN "credit_line_amount";