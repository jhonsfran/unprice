ALTER TABLE `wallet_reservation` ADD `target_reservation_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `spend_ewma_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `last_rate_sampled_at_ms` integer;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `max_event_cost_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `pending_refill_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wallet_reservation` ADD `pending_flush_amount` integer;
