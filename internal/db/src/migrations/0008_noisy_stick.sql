ALTER TABLE "unprice_invoices" ADD COLUMN "gross_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD COLUMN "amount_due" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD COLUMN "amount_paid" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_invoices" ADD COLUMN "amount_included" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "unprice_invoices"
SET
	"gross_amount" = "total_amount",
	"amount_due" = "total_amount",
	"amount_paid" = 0,
	"amount_included" = 0;--> statement-breakpoint
ALTER TABLE "unprice_invoices" DROP COLUMN "total_amount";
