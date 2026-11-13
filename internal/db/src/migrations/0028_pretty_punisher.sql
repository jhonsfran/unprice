CREATE TABLE "unprice_custom_model_costs" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"components" jsonb NOT NULL,
	"effective_from" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_model_costs_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_custom_model_costs" ADD CONSTRAINT "unprice_custom_model_costs_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_model_costs_model_idx" ON "unprice_custom_model_costs" USING btree ("project_id","provider","model","effective_from");