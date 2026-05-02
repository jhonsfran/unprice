CREATE TABLE `grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`amount` real,
	`anchor` integer NOT NULL,
	`currency_code` text NOT NULL,
	`effective_at` integer NOT NULL,
	`expires_at` integer,
	`feature_config` text NOT NULL,
	`feature_plan_version_id` text NOT NULL,
	`feature_slug` text NOT NULL,
	`meter_config` text NOT NULL,
	`meter_hash` text NOT NULL,
	`overage_strategy` text NOT NULL,
	`priority` integer NOT NULL,
	`reset_config` text,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `grant_windows` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`period_key` text NOT NULL,
	`period_start_at` integer NOT NULL,
	`period_end_at` integer NOT NULL,
	`consumed_in_current_window` real DEFAULT 0 NOT NULL,
	`exhausted_at` integer
);
--> statement-breakpoint
CREATE TABLE `meter_state` (
	`meter_key` text PRIMARY KEY NOT NULL,
	`usage` real DEFAULT 0 NOT NULL,
	`updated_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wallet_reservation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`customer_id` text,
	`currency` text NOT NULL,
	`reservation_end_at` integer,
	`reservation_id` text,
	`allocation_amount` integer DEFAULT 0 NOT NULL,
	`consumed_amount` integer DEFAULT 0 NOT NULL,
	`flushed_amount` integer DEFAULT 0 NOT NULL,
	`refill_threshold_bps` integer DEFAULT 2000 NOT NULL,
	`refill_chunk_amount` integer DEFAULT 0 NOT NULL,
	`refill_in_flight` integer DEFAULT false NOT NULL,
	`flush_seq` integer DEFAULT 0 NOT NULL,
	`pending_flush_seq` integer,
	`last_event_at` integer,
	`deletion_requested` integer DEFAULT false NOT NULL,
	`recovery_required` integer DEFAULT false NOT NULL,
	`last_flushed_at` integer
);
--> statement-breakpoint
DROP TABLE `meter_window`;
