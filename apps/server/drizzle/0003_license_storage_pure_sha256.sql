CREATE TABLE `licenses_v3` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`customer_email` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revoke_reason` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`expires_at` text,
	`suspended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `licenses`;
--> statement-breakpoint
ALTER TABLE `licenses_v3` RENAME TO `licenses`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_licenses_account_key_hash` ON `licenses` (`account_id`,`key_hash`);
--> statement-breakpoint
CREATE INDEX `idx_licenses_account_id` ON `licenses` (`account_id`);
--> statement-breakpoint
CREATE INDEX `idx_licenses_product_policy` ON `licenses` (`product_id`,`policy_id`);
--> statement-breakpoint
CREATE INDEX `idx_licenses_customer_email` ON `licenses` (`customer_email`);
--> statement-breakpoint
CREATE INDEX `idx_licenses_status` ON `licenses` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_licenses_source_status` ON `licenses` (`account_id`,`source`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_licenses_created_at` ON `licenses` (`created_at`);
--> statement-breakpoint
CREATE TABLE `machines_v3` (
	`id` text PRIMARY KEY NOT NULL,
	`license_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text,
	`platform` text,
	`ip` text,
	`last_heartbeat_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `machines`;
--> statement-breakpoint
ALTER TABLE `machines_v3` RENAME TO `machines`;
--> statement-breakpoint
CREATE INDEX `idx_machines_license_id` ON `machines` (`license_id`);
--> statement-breakpoint
CREATE INDEX `idx_machines_fingerprint` ON `machines` (`fingerprint`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_machines_license_fingerprint` ON `machines` (`license_id`,`fingerprint`);
--> statement-breakpoint
CREATE INDEX `idx_machines_token_hash` ON `machines` (`token_hash`);
