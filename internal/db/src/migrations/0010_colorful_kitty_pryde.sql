CREATE TABLE "unprice_agent_runs" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"agent_id" varchar(36) COLLATE "C" NOT NULL,
	"customer_id" varchar(36) COLLATE "C" NOT NULL,
	"parent_run_id" varchar(36) COLLATE "C",
	"status" text DEFAULT 'running' NOT NULL,
	"currency" text NOT NULL,
	"requested_budget_amount" bigint NOT NULL,
	"reserved_amount" bigint DEFAULT 0 NOT NULL,
	"consumed_amount" bigint DEFAULT 0 NOT NULL,
	"flushed_amount" bigint DEFAULT 0 NOT NULL,
	"reservation_id" varchar(36) COLLATE "C",
	"trace_id" text,
	"idempotency_key" text NOT NULL,
	"metadata" json DEFAULT '{}'::json NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "unprice_agents" (
	"id" varchar(36) COLLATE "C" NOT NULL,
	"project_id" varchar(36) COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"metadata" json DEFAULT '{}'::json NOT NULL,
	"active" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agents_pkey" PRIMARY KEY("id","project_id")
);
--> statement-breakpoint
DROP INDEX "entitlement_reservations_entitlement_period_idx";--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" ALTER COLUMN "entitlement_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" ADD COLUMN "owner_type" text DEFAULT 'entitlement_window' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_entitlement_reservations" ADD COLUMN "owner_id" varchar(36) COLLATE "C" NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_agent_runs" ADD CONSTRAINT "unprice_agent_runs_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_agents" ADD CONSTRAINT "unprice_agents_project_id_unprice_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_agent_idx" ON "unprice_agent_runs" USING btree ("project_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_runs_customer_idx" ON "unprice_agent_runs" USING btree ("project_id","customer_id");--> statement-breakpoint
CREATE INDEX "agent_runs_active_expiry_idx" ON "unprice_agent_runs" USING btree ("project_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "agent_runs_trace_idx" ON "unprice_agent_runs" USING btree ("project_id","trace_id");--> statement-breakpoint
CREATE INDEX "agent_runs_idempotency_idx" ON "unprice_agent_runs" USING btree ("project_id","agent_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agents_project_active_idx" ON "unprice_agents" USING btree ("project_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_reservations_owner_period_idx" ON "unprice_entitlement_reservations" USING btree ("project_id","owner_type","owner_id","period_start_at") WHERE "unprice_entitlement_reservations"."reconciled_at" IS NULL;