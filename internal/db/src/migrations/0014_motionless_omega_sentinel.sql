ALTER TABLE "unprice_customers" DROP CONSTRAINT "project_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_grants" DROP CONSTRAINT "project_id_fkey";
--> statement-breakpoint
ALTER TABLE "unprice_customers" ADD CONSTRAINT "project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unprice_grants" ADD CONSTRAINT "project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."unprice_projects"("id") ON DELETE cascade ON UPDATE no action;