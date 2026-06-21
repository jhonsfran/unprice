ALTER TABLE "unprice_budget_runs" RENAME COLUMN "agent_id" TO "workload_id";--> statement-breakpoint
ALTER TABLE "unprice_budget_runs" ADD COLUMN "workload_type" text;--> statement-breakpoint
ALTER TABLE "unprice_budget_runs" ADD COLUMN "parent_run_id" varchar(36) COLLATE "C";--> statement-breakpoint
CREATE INDEX "budget_runs_project_trace_idx" ON "unprice_budget_runs" USING btree ("project_id","trace_id");--> statement-breakpoint
CREATE INDEX "budget_runs_project_parent_idx" ON "unprice_budget_runs" USING btree ("project_id","parent_run_id");--> statement-breakpoint
CREATE INDEX "budget_runs_project_workload_idx" ON "unprice_budget_runs" USING btree ("project_id","workload_type","workload_id");