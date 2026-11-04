-- Custom SQL migration file, put your code below! ---- Rows written before usage vectors (ADR-0008 D1) store amounts as decimals, limits without a
-- measure, and holds with `amount`. No customer state exists (ADR-0008 Consequences), so they are
-- cleared instead of decoded: the next upsert creates the budget anew, and an armed alarm finds no
-- budget and stops.
DELETE FROM `budget_operations`;--> statement-breakpoint
DELETE FROM `budget_window_history`;--> statement-breakpoint
DELETE FROM `budget_ledger`;--> statement-breakpoint
DELETE FROM `budget`;
