CREATE TABLE "unprice_budgets" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"key" text NOT NULL,
	"unit" text NOT NULL,
	"version" integer NOT NULL,
	"cap" text NOT NULL,
	"limits" json NOT NULL,
	"closes_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_budgets" ADD CONSTRAINT "unprice_budgets_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_project_key_idx" ON "unprice_budgets" USING btree ("project_id","key" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "budgets_project_updated_idx" ON "unprice_budgets" USING btree ("project_id","updated_at");