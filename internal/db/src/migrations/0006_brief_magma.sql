CREATE TABLE "unprice_customer_entitlements" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at_m" bigint DEFAULT 0 NOT NULL,
	"updated_at_m" bigint DEFAULT 0 NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"feature_plan_version_id" varchar(36) COLLATE "C" NOT NULL,
	"subscription_id" varchar(36) COLLATE "C",
	"subscription_phase_id" varchar(36) COLLATE "C",
	"subscription_item_id" varchar(36) COLLATE "C",
	"effective_at" bigint NOT NULL,
	"expires_at" bigint,
	"allowance_units" integer,
	"overage_strategy" "overage_strategy" DEFAULT 'none' NOT NULL,
	"metadata" json,
	CONSTRAINT "customer_entitlements_pkey" PRIMARY KEY("id","project_id"),
	CONSTRAINT "unique_customer_entitlement_source_window" UNIQUE NULLS NOT DISTINCT("project_id","customer_id","feature_plan_version_id","subscription_id","subscription_phase_id","subscription_item_id","effective_at","expires_at")
);
--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "unprice_customer_entitlements_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_customer_id_fkey" FOREIGN KEY ("customer_id","project_id") REFERENCES "public"."unprice_customers"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_feature_plan_version_id_fkey" FOREIGN KEY ("feature_plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions_features"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_subscription_id_fkey" FOREIGN KEY ("subscription_id","project_id") REFERENCES "public"."unprice_subscriptions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_subscription_phase_id_fkey" FOREIGN KEY ("subscription_phase_id","project_id") REFERENCES "public"."unprice_subscription_phases"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_customer_entitlements" ADD CONSTRAINT "customer_entitlements_subscription_item_id_fkey" FOREIGN KEY ("subscription_item_id","project_id") REFERENCES "public"."unprice_subscription_items"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customer_entitlements_customer_window" ON "unprice_customer_entitlements" USING btree ("project_id","customer_id","effective_at","expires_at");--> statement-breakpoint
CREATE INDEX "idx_customer_entitlements_phase_source" ON "unprice_customer_entitlements" USING btree ("project_id","customer_id","subscription_phase_id","feature_plan_version_id","effective_at","expires_at");