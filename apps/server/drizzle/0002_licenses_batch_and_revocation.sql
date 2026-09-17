CREATE TABLE `licenses_new` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`key` text NOT NULL,
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
INSERT INTO `licenses_new` (`id`, `account_id`, `product_id`, `policy_id`, `key`, `customer_email`, `source`, `status`, `revoke_reason`, `metadata`, `expires_at`, `suspended_at`, `created_at`, `updated_at`)
SELECT `id`, `account_id`, `product_id`, `policy_id`, `key`, `customer_email`, 'manual', `status`, NULL, `metadata`, `expires_at`, `suspended_at`, `created_at`, `updated_at` FROM `licenses`;
--> statement-breakpoint
DROP TABLE `licenses`;
--> statement-breakpoint
ALTER TABLE `licenses_new` RENAME TO `licenses`;
--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_key_unique` ON `licenses` (`key`);
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
