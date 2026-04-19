CREATE TABLE `meter_window` (
	`meter_key` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`price_config` text NOT NULL,
	`period_end_at` integer,
	`usage` real DEFAULT 0 NOT NULL,
	`updated_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `meter_window` (`meter_key`, `currency`, `price_config`, `period_end_at`, `usage`, `updated_at`, `created_at`)
SELECT
	p.`meter_key`,
	p.`currency`,
	p.`price_config`,
	NULL,
	COALESCE((SELECT `value` FROM `meter_state` WHERE `key` = 'meter-state:' || p.`meter_key` LIMIT 1), 0),
	(SELECT `value` FROM `meter_state` WHERE `key` = 'meter-state-updated-at:' || p.`meter_key` LIMIT 1),
	p.`created_at`
FROM `meter_pricing` p;
--> statement-breakpoint
DROP TABLE `meter_pricing`;--> statement-breakpoint
DROP TABLE `meter_state`;
