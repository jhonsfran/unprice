CREATE TABLE `ingestion_audit_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`first_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`entries_json` text NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_ingestion_audit_batches_unpublished` ON `ingestion_audit_batches` (`first_seen_at`) WHERE "ingestion_audit_batches"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_ingestion_audit_batches_published_retention` ON `ingestion_audit_batches` (`first_seen_at`) WHERE "ingestion_audit_batches"."published_at" IS NOT NULL;