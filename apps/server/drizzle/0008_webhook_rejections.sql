CREATE TABLE `webhook_rejections` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`billing_provider_id` text NOT NULL,
	`request_id` text NOT NULL,
	`error_code` text NOT NULL,
	`http_status` integer NOT NULL,
	`webhook_secret_version` integer NOT NULL,
	`payload_hash` text,
	`received_at` text NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`instance_id`,`billing_provider_id`) REFERENCES `billing_providers`(`instance_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_webhook_rejections_http_status" CHECK("webhook_rejections"."http_status" between 400 and 499)
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_rejections_recent` ON `webhook_rejections` (`instance_id`,"received_at" desc);--> statement-breakpoint
CREATE INDEX `idx_webhook_rejections_request` ON `webhook_rejections` (`instance_id`,`request_id`);