CREATE TABLE `budget_entries` (
	`seq` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`fact_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_ledger` (
	`id` integer PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`last_at` integer NOT NULL,
	`hold_seq` integer NOT NULL,
	`held` text NOT NULL,
	`usage_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`key_hash` text NOT NULL,
	`due_at` integer NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `budget_operations_due_at_idx` ON `budget_operations` (`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_operations_key_hash_idx` ON `budget_operations` (`key_hash`);--> statement-breakpoint
CREATE TABLE `budget` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`project_id` text NOT NULL,
	`unit` text NOT NULL,
	`version` integer NOT NULL,
	`config_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
