CREATE TABLE `entitlement_period_usage` (
	`period_key` text PRIMARY KEY NOT NULL,
	`period_start_at` integer NOT NULL,
	`period_end_at` integer NOT NULL,
	`grant_states_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entitlement_period_usage_period_end_at` ON `entitlement_period_usage` (`period_end_at`);--> statement-breakpoint
DROP TABLE `grant_windows`;--> statement-breakpoint
DROP TABLE `meter_facts_outbox_batches`;