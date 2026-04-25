DROP INDEX IF EXISTS "entitlement_reservations_entitlement_period_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_reservations_entitlement_period_idx" ON "unprice_entitlement_reservations" USING btree ("project_id","entitlement_id","period_start_at") WHERE "unprice_entitlement_reservations"."reconciled_at" IS NULL;
