CREATE TABLE `budget_cards` (
	`card_id` text PRIMARY KEY NOT NULL,
	`card_json` text NOT NULL,
	`refreshed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_positions` (
	`period_id` text NOT NULL,
	`position_key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`period_id`, `position_key`)
);
--> statement-breakpoint
CREATE TABLE `budget_statements` (
	`period_id` text PRIMARY KEY NOT NULL,
	`statement_key` text NOT NULL,
	`feature_slug` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`state` text NOT NULL,
	`registered_at` integer NOT NULL,
	`sealed_at` integer,
	`completed_at` integer,
	`totals_json` text NOT NULL,
	`events` integer NOT NULL,
	`last_event_at` integer
);
--> statement-breakpoint
CREATE INDEX `budget_statements_feature_idx` ON `budget_statements` (`feature_slug`,`end`);--> statement-breakpoint
CREATE INDEX `budget_statements_key_idx` ON `budget_statements` (`statement_key`,`end`);