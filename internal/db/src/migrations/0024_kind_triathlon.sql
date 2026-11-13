CREATE TABLE "unprice_model_costs" (
	"id" varchar(36) COLLATE "C" PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"components" jsonb NOT NULL,
	"effective_from" bigint NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unprice_rate_card_rows" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"rate_card_id" varchar(36) COLLATE "C" NOT NULL,
	"feature_slug" text NOT NULL,
	"match" jsonb NOT NULL,
	"price" jsonb NOT NULL,
	"cost" jsonb,
	"effective_from" bigint NOT NULL,
	"effective_to" bigint,
	"source" text NOT NULL,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_card_rows_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_rate_cards" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"credit_value_usd" text,
	"margin_policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_cards_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_rate_card_rows" ADD CONSTRAINT "unprice_rate_card_rows_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_rate_card_rows" ADD CONSTRAINT "rate_card_rows_rate_card_id_fkey" FOREIGN KEY ("rate_card_id","project_id") REFERENCES "public"."unprice_rate_cards"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_rate_cards" ADD CONSTRAINT "unprice_rate_cards_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_costs_version_idx" ON "unprice_model_costs" USING btree ("provider","model","source","effective_from");--> statement-breakpoint
CREATE INDEX "rate_card_rows_card_feature_from_idx" ON "unprice_rate_card_rows" USING btree ("rate_card_id","feature_slug","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_cards_project_name_idx" ON "unprice_rate_cards" USING btree ("project_id","name");