ALTER TABLE `usagelimiter_v2_usage_records` ADD `meta_id` text DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE `usagelimiter_v2_verifications` ADD `meta_id` text DEFAULT '0' NOT NULL;
--> statement-breakpoint
CREATE TABLE `usagelimiter_v2_metadata_records` (
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`timestamp` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`id`, `project_id`, `customer_id`)
);
--> statement-breakpoint
CREATE INDEX `metadata_records_timestamp_idx` ON `usagelimiter_v2_metadata_records` (`timestamp`);--> statement-breakpoint
CREATE INDEX `metadata_records_project_idx` ON `usagelimiter_v2_metadata_records` (`project_id`,`customer_id`);
