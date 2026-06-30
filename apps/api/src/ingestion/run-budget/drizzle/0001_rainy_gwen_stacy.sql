ALTER TABLE `run_state` ADD `workload_type` text;--> statement-breakpoint
ALTER TABLE `run_state` ADD `workload_id` text;--> statement-breakpoint
ALTER TABLE `run_state` ADD `parent_run_id` text;--> statement-breakpoint
UPDATE `run_state` SET `workload_type` = 'agent', `workload_id` = `agent_id` WHERE `agent_id` IS NOT NULL AND `agent_id` != '';--> statement-breakpoint
ALTER TABLE `run_state` DROP COLUMN `agent_id`;
