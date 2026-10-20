ALTER TABLE "unprice_budget_audit" ADD COLUMN "subject_created_at" timestamp with time zone;--> statement-breakpoint
UPDATE "unprice_budget_audit" SET "subject_created_at" = "created_at" WHERE "subject_created_at" IS NULL;--> statement-breakpoint
ALTER TABLE "unprice_budget_audit" ALTER COLUMN "subject_created_at" SET NOT NULL;--> statement-breakpoint
DROP INDEX "budget_audit_subject_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "budget_audit_subject_idx" ON "unprice_budget_audit" USING btree ("project_id","budget_id","action","subject","subject_created_at");