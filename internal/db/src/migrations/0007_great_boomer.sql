DO $$
DECLARE
	non_customer_grants integer;
BEGIN
	SELECT count(*)
	INTO non_customer_grants
	FROM "unprice_grants"
	WHERE "subject_type" IS DISTINCT FROM 'customer';

	IF non_customer_grants > 0 THEN
		RAISE EXCEPTION 'Cannot migrate grants to customer entitlements: % grant(s) are not customer-owned', non_customer_grants;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "unprice_grants" RENAME COLUMN "limit" TO "allowance_units";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP CONSTRAINT "unique_grant";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP CONSTRAINT "feature_plan_version_id_fkey";
--> statement-breakpoint
DROP INDEX "idx_grants_subject_feature_effective";--> statement-breakpoint
DROP INDEX "idx_grants_feature_version_effective";--> statement-breakpoint
DROP INDEX "idx_grants_route";--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD COLUMN "customer_entitlement_id" varchar(36) COLLATE "C";
--> statement-breakpoint
DO $$
DECLARE
	ambiguous_grants integer;
	unmatched_grants integer;
BEGIN
	WITH candidates AS (
		SELECT
			g."id",
			g."project_id",
			count(*) AS candidate_count
		FROM "unprice_grants" g
		INNER JOIN "unprice_customer_entitlements" ce
			ON ce."project_id" = g."project_id"
			AND ce."customer_id" = g."subject_id"
			AND ce."feature_plan_version_id" = g."feature_plan_version_id"
			AND g."effective_at" < coalesce(ce."expires_at", 9223372036854775807)
			AND coalesce(g."expires_at", 9223372036854775807) > ce."effective_at"
		GROUP BY g."id", g."project_id"
	)
	SELECT count(*)
	INTO ambiguous_grants
	FROM candidates
	WHERE candidate_count > 1;

	IF ambiguous_grants > 0 THEN
		RAISE EXCEPTION 'Cannot migrate grants to customer entitlements: % grant(s) match multiple customer entitlements', ambiguous_grants;
	END IF;

	WITH candidates AS (
		SELECT
			g."id",
			g."project_id",
			ce."id" AS "customer_entitlement_id"
		FROM "unprice_grants" g
		INNER JOIN "unprice_customer_entitlements" ce
			ON ce."project_id" = g."project_id"
			AND ce."customer_id" = g."subject_id"
			AND ce."feature_plan_version_id" = g."feature_plan_version_id"
			AND g."effective_at" < coalesce(ce."expires_at", 9223372036854775807)
			AND coalesce(g."expires_at", 9223372036854775807) > ce."effective_at"
	)
	UPDATE "unprice_grants" g
	SET "customer_entitlement_id" = candidates."customer_entitlement_id"
	FROM candidates
	WHERE g."id" = candidates."id"
		AND g."project_id" = candidates."project_id";

	SELECT count(*)
	INTO unmatched_grants
	FROM "unprice_grants"
	WHERE "customer_entitlement_id" IS NULL;

	IF unmatched_grants > 0 THEN
		RAISE EXCEPTION 'Cannot migrate grants to customer entitlements: % grant(s) do not match a customer entitlement', unmatched_grants;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "unprice_grants" ALTER COLUMN "customer_entitlement_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "grants_customer_entitlement_id_fkey" FOREIGN KEY ("customer_entitlement_id","project_id") REFERENCES "public"."unprice_customer_entitlements"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_grants_customer_entitlement_effective" ON "unprice_grants" USING btree ("project_id","customer_entitlement_id","effective_at","expires_at","priority");--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "feature_plan_version_id";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "subject_type";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "subject_id";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "meter_hash";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "deleted";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "deleted_at";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "overage_strategy";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "units";--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP COLUMN "anchor";--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "unique_grant" UNIQUE NULLS NOT DISTINCT("project_id","customer_entitlement_id","type","effective_at","expires_at");
