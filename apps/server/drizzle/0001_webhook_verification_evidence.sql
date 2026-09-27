ALTER TABLE `billing_providers` ADD `webhook_secret_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inbound_events` ADD `webhook_secret_version` integer;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_webhook_verification` ON `inbound_events` (`instance_id`,`billing_provider_id`,`webhook_secret_version`,"received_at" desc);
