CREATE TABLE `usagelimiter_v2_state_objects` (
	`collection` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`collection`, `key`)
);
--> statement-breakpoint
CREATE INDEX `state_objects_collection_updated_idx` ON `usagelimiter_v2_state_objects` (`collection`,`updated_at`);--> statement-breakpoint
CREATE TABLE `usagelimiter_v2_dedupe_keys` (
	`scope` text NOT NULL,
	`event_date` text NOT NULL,
	`id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `event_date`, `id`)
);
--> statement-breakpoint
CREATE INDEX `dedupe_keys_scope_date_idx` ON `usagelimiter_v2_dedupe_keys` (`scope`,`event_date`);
