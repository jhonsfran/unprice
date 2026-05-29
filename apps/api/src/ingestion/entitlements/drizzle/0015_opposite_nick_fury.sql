CREATE TABLE `idempotency_key_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`entries` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_idempotency_key_batches_created_at` ON `idempotency_key_batches` (`created_at`);--> statement-breakpoint
CREATE TABLE `meter_facts_outbox_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payloads` text NOT NULL,
	`currency` text NOT NULL,
	`created_at` integer NOT NULL
);
