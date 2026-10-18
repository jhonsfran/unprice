DROP INDEX `budget_operations_terminal_due_idx`;--> statement-breakpoint
CREATE INDEX `budget_operations_due_idx` ON `budget_operations` (`due_at`);