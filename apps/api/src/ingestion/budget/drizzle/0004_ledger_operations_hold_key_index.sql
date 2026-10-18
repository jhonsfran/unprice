DROP INDEX `budget_operations_key_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `budget_operations_hold_key_idx` ON `budget_operations` (data_json ->> '$.idempotencyKey') WHERE kind = 'hold';--> statement-breakpoint
ALTER TABLE `budget_ledger` ADD `operations_json` text DEFAULT '{"upsert":0,"authorize":0,"settle":0,"release":0,"charge":0,"record":0}' NOT NULL;