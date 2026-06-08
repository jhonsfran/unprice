ALTER TABLE `wallet_reservation` ADD `billing_period_id` text;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `cycle_end_at` integer;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `cycle_start_at` integer;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `feature_plan_version_item_id` text;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `feature_slug` text;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `statement_key` text;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `consumed_quantity` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `flushed_quantity` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `pending_flush_quantity` real;