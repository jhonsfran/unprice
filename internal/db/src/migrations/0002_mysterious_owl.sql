CREATE TABLE "unprice_customer_provider_ids" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customer_id" varchar(36) NOT NULL,
	"provider" "payment_providers" NOT NULL,
	"provider_customer_id" text NOT NULL,
	"metadata" json,
	CONSTRAINT "customer_provider_ids_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_webhook_events" (
	"id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"provider" "payment_providers" NOT NULL,
	"provider_event_id" text NOT NULL,
	"raw_payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signature" text,
	"headers" json,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at_m" bigint,
	"error_payload" json,
	CONSTRAINT "webhook_events_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_customers" DROP CONSTRAINT "stripe_customer_unique";--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ADD COLUMN "webhook_secret_iv" text;--> statement-breakpoint
ALTER TABLE "unprice_subscription_phases" ADD COLUMN "payment_provider" "payment_providers" DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
UPDATE "unprice_subscription_phases" AS "phase"
SET "payment_provider" = "version"."payment_providers"
FROM "unprice_plan_versions" AS "version"
WHERE
	"phase"."project_id" = "version"."project_id"
	AND "phase"."plan_version_id" = "version"."id";--> statement-breakpoint
ALTER TABLE "unprice_customer_provider_ids" ADD CONSTRAINT "unprice_customer_provider_ids_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_provider_ids" ADD CONSTRAINT "customer_provider_ids_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_webhook_events" ADD CONSTRAINT "unprice_webhook_events_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_provider_ids_customer_provider_uq" ON "unprice_customer_provider_ids" USING btree ("project_id","customer_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_provider_ids_provider_customer_uq" ON "unprice_customer_provider_ids" USING btree ("project_id","provider","provider_customer_id");--> statement-breakpoint
CREATE INDEX "customer_provider_ids_customer_idx" ON "unprice_customer_provider_ids" USING btree ("project_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "unprice_webhook_events" USING btree ("project_id","provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "unprice_webhook_events" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_project_stripe_customer_id_uq" ON "unprice_customers" USING btree ("project_id","stripe_customer_id") WHERE "unprice_customers"."stripe_customer_id" IS NOT NULL;
