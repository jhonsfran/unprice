DROP TABLE `idempotency_keys`;--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`event_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`allowed` integer NOT NULL,
	`denied_reason` text,
	`deny_message` text
);
--> statement-breakpoint
ALTER TABLE `meter_facts_outbox` DROP COLUMN `billed_at`;--> statement-breakpoint
CREATE TABLE `meter_pricing` (
	`meter_key` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`price_config` text NOT NULL,
	`pinned_plan_version_id` text NOT NULL,
	`created_at` integer NOT NULL
);
