CREATE TABLE `entitlement_config` (
	`customer_entitlement_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`effective_at` integer NOT NULL,
	`expires_at` integer,
	`feature_config` text NOT NULL,
	`feature_plan_version_id` text NOT NULL,
	`feature_slug` text NOT NULL,
	`meter_config` text NOT NULL,
	`overage_strategy` text NOT NULL,
	`reset_config` text,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `grants` RENAME TO `grants_legacy`;
--> statement-breakpoint
CREATE TABLE `grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`customer_entitlement_id` text NOT NULL,
	`allowance_units` real,
	`effective_at` integer NOT NULL,
	`expires_at` integer,
	`priority` integer NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
DROP TABLE `grants_legacy`;
--> statement-breakpoint
DELETE FROM `grant_windows`;
