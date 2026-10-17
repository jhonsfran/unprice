CREATE TABLE `budget_record_receipts` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`amount` text NOT NULL,
	`crossed_json` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `budget_record_receipts_expires_at_idx` ON `budget_record_receipts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `budget_window_history` (
	`window_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`consumed` text NOT NULL,
	PRIMARY KEY(`window_id`, `start`)
);
