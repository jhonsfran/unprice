CREATE TABLE "unprice_budget_runs" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"budget_amount" bigint NOT NULL,
	"consumed_amount" bigint DEFAULT 0 NOT NULL,
	"remaining_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"wallet_reservation_id" text,
	"idempotency_key" text NOT NULL,
	"agent_id" text,
	"trace_id" text,
	"metadata" json DEFAULT '{}'::json NOT NULL,
	"expires_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_runs_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
DROP TABLE "unprice_agent_runs" CASCADE;--> statement-breakpoint
DROP TABLE "unprice_agents" CASCADE;--> statement-breakpoint
ALTER TABLE "unprice_budget_runs" ADD CONSTRAINT "unprice_budget_runs_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_runs_project_customer_idx" ON "unprice_budget_runs" USING btree ("project_id","customer_id");--> statement-breakpoint
CREATE INDEX "budget_runs_project_status_idx" ON "unprice_budget_runs" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_runs_project_customer_idempotency_idx" ON "unprice_budget_runs" USING btree ("project_id","customer_id","idempotency_key");