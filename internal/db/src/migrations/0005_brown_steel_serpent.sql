ALTER TABLE "unprice_grants" ADD COLUMN "meter_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "auto_renew";--> statement-breakpoint
CREATE INDEX "idx_grants_route" ON "unprice_grants" USING btree ("project_id","subject_id","subject_type","meter_hash","effective_at");
