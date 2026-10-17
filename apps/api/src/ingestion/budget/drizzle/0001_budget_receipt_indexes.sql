DROP INDEX `budget_operations_due_at_idx`;--> statement-breakpoint
DROP INDEX `budget_operations_key_hash_idx`;--> statement-breakpoint
CREATE INDEX `budget_operations_terminal_due_idx` ON `budget_operations` (`due_at`) WHERE status IN ('done', 'settled', 'released');--> statement-breakpoint
CREATE UNIQUE INDEX `budget_operations_key_idx` ON `budget_operations` (data_json ->> '$.idempotencyKey');--> statement-breakpoint
ALTER TABLE `budget_operations` DROP COLUMN `key_hash`;