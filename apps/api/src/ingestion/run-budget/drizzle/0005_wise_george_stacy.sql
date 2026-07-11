ALTER TABLE `run_capture_intents` ADD `flush_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `run_capture_intents` ADD `range_start_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `run_capture_intents` ADD `target_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `run_state` ADD `last_capture_seq` integer DEFAULT 0 NOT NULL;