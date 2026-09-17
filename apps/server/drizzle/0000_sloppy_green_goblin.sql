CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`custom_domain` text,
	`payment_configs` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_slug_unique` ON `accounts` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_custom_domain_unique` ON `accounts` (`custom_domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_accounts_slug` ON `accounts` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_accounts_custom_domain` ON `accounts` (`custom_domain`);--> statement-breakpoint
CREATE TABLE `crypto_keys` (
	`kid` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`algorithm` text DEFAULT 'Ed25519' NOT NULL,
	`source` text DEFAULT 'platform' NOT NULL,
	`public_key` text NOT NULL,
	`key_material` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_crypto_keys_account_product` ON `crypto_keys` (`account_id`,`product_id`);--> statement-breakpoint
CREATE TABLE `licenses` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`key` text NOT NULL,
	`customer_email` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`expires_at` text,
	`suspended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_key_unique` ON `licenses` (`key`);--> statement-breakpoint
CREATE INDEX `idx_licenses_account_id` ON `licenses` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_licenses_product_policy` ON `licenses` (`product_id`,`policy_id`);--> statement-breakpoint
CREATE INDEX `idx_licenses_customer_email` ON `licenses` (`customer_email`);--> statement-breakpoint
CREATE INDEX `idx_licenses_status` ON `licenses` (`status`);--> statement-breakpoint
CREATE INDEX `idx_licenses_created_at` ON `licenses` (`created_at`);--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`license_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`name` text,
	`platform` text,
	`ip` text,
	`last_heartbeat_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_machines_license_id` ON `machines` (`license_id`);--> statement-breakpoint
CREATE INDEX `idx_machines_fingerprint` ON `machines` (`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_machines_license_fingerprint` ON `machines` (`license_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`duration` integer,
	`offline_grace_period` integer DEFAULT 2592000 NOT NULL,
	`max_machines` integer DEFAULT 1 NOT NULL,
	`floating` integer DEFAULT false NOT NULL,
	`strict` integer DEFAULT true NOT NULL,
	`scheme` text DEFAULT 'ed25519' NOT NULL,
	`features` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_policies_account_id` ON `policies` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_policies_product_id` ON `policies` (`product_id`);--> statement-breakpoint
CREATE TABLE `product_trials` (
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`claimed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `product_id`, `fingerprint`)
);
--> statement-breakpoint
CREATE INDEX `idx_product_trials_account` ON `product_trials` (`account_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`trial_days` integer DEFAULT 14 NOT NULL,
	`trial_features` text DEFAULT '[]' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_products_account_id` ON `products` (`account_id`);--> statement-breakpoint
CREATE TABLE `system_settings` (
	`id` text PRIMARY KEY DEFAULT 'current' NOT NULL,
	`instance_name` text NOT NULL,
	`app_url` text NOT NULL,
	`api_base_url` text,
	`allow_signup` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_account_id` ON `users` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`events` text DEFAULT '["*"]' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_endpoints_account` ON `webhook_endpoints` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_endpoints_product` ON `webhook_endpoints` (`product_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`direction` text NOT NULL,
	`endpoint_id` text,
	`event_id` text,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_events_account` ON `webhook_events` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_events_dir_status` ON `webhook_events` (`direction`,`status`,`created_at`);