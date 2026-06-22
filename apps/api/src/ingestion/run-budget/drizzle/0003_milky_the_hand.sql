ALTER TABLE `run_spend_buckets` ADD `feature_plan_version_item_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `run_spend_buckets` ADD `feature_slug` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `run_spend_buckets` ADD `quantity` real DEFAULT 0 NOT NULL;