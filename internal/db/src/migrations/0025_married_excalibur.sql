CREATE TABLE "unprice_plan_version_rate_cards" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"plan_version_id" varchar(36) COLLATE "C" NOT NULL,
	"currency" "currency" NOT NULL,
	"rate_card_id" varchar(36) COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_version_rate_cards_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" ADD COLUMN "included" text;--> statement-breakpoint
ALTER TABLE "unprice_plan_version_rate_cards" ADD CONSTRAINT "unprice_plan_version_rate_cards_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plan_version_rate_cards" ADD CONSTRAINT "plan_version_rate_cards_plan_version_id_fkey" FOREIGN KEY ("plan_version_id","project_id") REFERENCES "public"."unprice_plan_versions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_plan_version_rate_cards" ADD CONSTRAINT "plan_version_rate_cards_rate_card_id_fkey" FOREIGN KEY ("rate_card_id","project_id") REFERENCES "public"."unprice_rate_cards"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_version_rate_cards_version_currency_idx" ON "unprice_plan_version_rate_cards" USING btree ("project_id","plan_version_id","currency");