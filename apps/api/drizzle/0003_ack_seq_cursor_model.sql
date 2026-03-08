ALTER TABLE `usagelimiter_v2_usage_records` ADD `seq` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `usagelimiter_v2_verifications` ADD `seq` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `usagelimiter_v2_usage_records` SET `seq` = rowid WHERE `seq` = 0;
--> statement-breakpoint
UPDATE `usagelimiter_v2_verifications` SET `seq` = `id` WHERE `seq` = 0;
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_seq_idx` ON `usagelimiter_v2_usage_records` (`seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `verifications_seq_idx` ON `usagelimiter_v2_verifications` (`seq`);
--> statement-breakpoint
CREATE TABLE `usagelimiter_v2_delivery_sequences` (
	`stream` text PRIMARY KEY NOT NULL,
	`current_seq` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_sequences_updated_idx` ON `usagelimiter_v2_delivery_sequences` (`updated_at`);
--> statement-breakpoint
INSERT INTO `usagelimiter_v2_delivery_sequences` (`stream`, `current_seq`, `updated_at`)
VALUES
	('usage', (SELECT coalesce(max(`seq`), 0) FROM `usagelimiter_v2_usage_records`), CAST(strftime('%s', 'now') AS integer) * 1000),
	('verification', (SELECT coalesce(max(`seq`), 0) FROM `usagelimiter_v2_verifications`), CAST(strftime('%s', 'now') AS integer) * 1000)
ON CONFLICT(`stream`) DO UPDATE SET
	`current_seq` = excluded.`current_seq`,
	`updated_at` = excluded.`updated_at`;
