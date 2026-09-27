CREATE TABLE `billing_webhook_simulation_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`billing_provider_id` text NOT NULL,
	`event_type` text NOT NULL,
	`simulator_webhook_secret_version` integer NOT NULL,
	`external_event_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`verified_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`instance_id`,`billing_provider_id`) REFERENCES `billing_providers`(`instance_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_billing_webhook_simulation_tests_event_type" CHECK("billing_webhook_simulation_tests"."event_type" in ('transaction.completed', 'adjustment.created', 'adjustment.updated', 'customer.created', 'customer.updated', 'subscription.created', 'subscription.updated'))
);
--> statement-breakpoint
CREATE INDEX `idx_billing_webhook_simulation_tests_verification` ON `billing_webhook_simulation_tests` (`instance_id`,`billing_provider_id`,`simulator_webhook_secret_version`,`event_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_webhook_simulation_tests_event` ON `billing_webhook_simulation_tests` (`instance_id`,`billing_provider_id`,`event_type`);--> statement-breakpoint
ALTER TABLE `billing_providers` ADD `simulator_webhook_secret_ciphertext` text;--> statement-breakpoint
ALTER TABLE `billing_providers` ADD `simulator_webhook_secret_version` integer DEFAULT 1 NOT NULL;
