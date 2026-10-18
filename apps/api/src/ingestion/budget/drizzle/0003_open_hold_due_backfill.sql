-- Custom SQL migration file, put your code below! --
-- Open holds stored due_at = 0 before the alarm settled expired holds; give them their expiry.
UPDATE `budget_operations` SET `due_at` = data_json ->> '$.expiresAt' WHERE `status` = 'open';
