CREATE TABLE "unprice_budget_audit" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"budget_id" varchar(36) COLLATE "C" NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"actor_user_id" varchar(36) COLLATE "C" NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"released" text,
	"rejection_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_audit_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
ALTER TABLE "unprice_budget_audit" ADD CONSTRAINT "unprice_budget_audit_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_audit_subject_idx" ON "unprice_budget_audit" USING btree ("project_id","budget_id","action","subject");--> statement-breakpoint
CREATE INDEX "budget_audit_budget_created_idx" ON "unprice_budget_audit" USING btree ("project_id","budget_id","created_at");