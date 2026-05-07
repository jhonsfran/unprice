CREATE TYPE "public"."payment_provider_connection_mode" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."payment_provider_connection_status" AS ENUM('not_connected', 'pending', 'active', 'restricted', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."payment_provider_connection_type" AS ENUM('managed_connection', 'bring_your_own_key');--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ALTER COLUMN "key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ALTER COLUMN "key_iv" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ADD COLUMN "connection_type" "payment_provider_connection_type" DEFAULT 'bring_your_own_key' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ADD COLUMN "mode" "payment_provider_connection_mode" DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ADD COLUMN "status" "payment_provider_connection_status" DEFAULT 'not_connected' NOT NULL;--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ADD COLUMN "external_account_id" text;--> statement-breakpoint
ALTER TABLE "unprice_payment_provider_config" ADD COLUMN "connection_data" json;