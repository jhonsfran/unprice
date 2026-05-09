ALTER TABLE `meter_window` ADD `reservation_id` text;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `allocation_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `consumed_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `flushed_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `refill_threshold_bps` integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `refill_chunk_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `refill_in_flight` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `flush_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `pending_flush_seq` integer;