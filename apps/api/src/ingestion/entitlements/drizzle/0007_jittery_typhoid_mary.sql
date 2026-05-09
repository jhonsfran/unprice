ALTER TABLE `meter_window` ADD `last_event_at` integer;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `deletion_requested` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `meter_window` ADD `recovery_required` integer DEFAULT false NOT NULL;