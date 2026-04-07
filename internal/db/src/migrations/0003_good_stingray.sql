DROP INDEX "customers_project_stripe_customer_id_uq";--> statement-breakpoint
ALTER TABLE "unprice_customers" DROP COLUMN "stripe_customer_id";