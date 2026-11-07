ALTER TABLE `budget_ledger` ADD `journal_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_ledger` ADD `exported_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_operations` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_operations` ADD `written_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `budget_operations_journal_idx` ON `budget_operations` (`seq`);