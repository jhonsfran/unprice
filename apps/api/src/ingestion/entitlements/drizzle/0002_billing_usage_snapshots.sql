CREATE TABLE `billing_usage_snapshots` (
	`billing_period_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_billing_usage_snapshots_state` ON `billing_usage_snapshots` (`state`);