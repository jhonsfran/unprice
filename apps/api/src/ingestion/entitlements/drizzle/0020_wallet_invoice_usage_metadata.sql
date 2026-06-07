ALTER TABLE `wallet_reservation` ADD `feature_slug` text;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `consumed_quantity` real NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `flushed_quantity` real NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `pending_flush_quantity` real;
