CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_email` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`details` text DEFAULT '{}' NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_account_created` ON `audit_logs` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_user` ON `audit_logs` (`account_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_action` ON `audit_logs` (`account_id`,`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_resource` ON `audit_logs` (`account_id`,`resource_type`,`resource_id`);