CREATE TABLE `budget_record_keys` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `budget_record_keys_expires_at_idx` ON `budget_record_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `budget_window_history` (
	`window_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`consumed` text NOT NULL,
	PRIMARY KEY(`window_id`, `start`)
);
