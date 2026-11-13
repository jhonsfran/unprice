CREATE TABLE `budget_journal_backlog` (
	`seq` integer PRIMARY KEY NOT NULL,
	`stored_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`data_json` text NOT NULL,
	`written_at` integer NOT NULL
);
