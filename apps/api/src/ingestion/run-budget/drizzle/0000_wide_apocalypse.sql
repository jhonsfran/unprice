CREATE TABLE `run_capture_intents` (
	`intent_key` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`bucket_key` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_idempotency` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`decision_json` text NOT NULL,
	`priced_amount` integer DEFAULT 0 NOT NULL,
	`bucket_deltas_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_spend_buckets` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`entitlement_id` text NOT NULL,
	`feature_id` text,
	`statement_key` text NOT NULL,
	`period_start_at` integer NOT NULL,
	`period_end_at` integer NOT NULL,
	`currency` text NOT NULL,
	`consumed_amount` integer DEFAULT 0 NOT NULL,
	`flushed_amount` integer DEFAULT 0 NOT NULL,
	`pending_amount` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_spend_buckets_run_bucket_idx` ON `run_spend_buckets` (`run_id`,`bucket_key`);--> statement-breakpoint
CREATE TABLE `run_state` (
	`run_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`reservation_id` text,
	`status` text NOT NULL,
	`currency` text NOT NULL,
	`budget_amount` integer NOT NULL,
	`reserved_amount` integer DEFAULT 0 NOT NULL,
	`consumed_amount` integer DEFAULT 0 NOT NULL,
	`flushed_amount` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`expires_at` integer,
	`last_event_at` integer,
	`trace_id` text,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
