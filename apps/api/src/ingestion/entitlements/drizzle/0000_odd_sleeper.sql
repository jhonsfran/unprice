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
CREATE TABLE `entitlement_period_usage` (
	`period_key` text PRIMARY KEY NOT NULL,
	`period_start_at` integer NOT NULL,
	`period_end_at` integer NOT NULL,
	`grant_states_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entitlement_period_usage_period_end_at` ON `entitlement_period_usage` (`period_end_at`);--> statement-breakpoint
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
CREATE TABLE `idempotency_key_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`entries` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_idempotency_key_batches_created_at` ON `idempotency_key_batches` (`created_at`);--> statement-breakpoint
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
	`billing_period_id` text,
	`cycle_end_at` integer,
	`cycle_start_at` integer,
	`feature_plan_version_item_id` text,
	`feature_slug` text,
	`statement_key` text,
	`reservation_id` text,
	`allocation_amount` integer DEFAULT 0 NOT NULL,
	`consumed_amount` integer DEFAULT 0 NOT NULL,
	`flushed_amount` integer DEFAULT 0 NOT NULL,
	`consumed_quantity` real DEFAULT 0 NOT NULL,
	`flushed_quantity` real DEFAULT 0 NOT NULL,
	`refill_threshold_bps` integer DEFAULT 2000 NOT NULL,
	`refill_chunk_amount` integer DEFAULT 0 NOT NULL,
	`target_reservation_amount` integer DEFAULT 0 NOT NULL,
	`spend_ewma_amount` integer DEFAULT 0 NOT NULL,
	`last_rate_sampled_at_ms` integer,
	`max_event_cost_amount` integer DEFAULT 0 NOT NULL,
	`pending_refill_amount` integer DEFAULT 0 NOT NULL,
	`pending_flush_amount` integer,
	`pending_flush_quantity` real,
	`refill_in_flight` integer DEFAULT false NOT NULL,
	`flush_seq` integer DEFAULT 0 NOT NULL,
	`pending_flush_seq` integer,
	`pending_flush_final` integer DEFAULT false NOT NULL,
	`last_event_at` integer,
	`deletion_requested` integer DEFAULT false NOT NULL,
	`recovery_required` integer DEFAULT false NOT NULL,
	`last_flushed_at` integer
);
