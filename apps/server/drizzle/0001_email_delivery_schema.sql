CREATE TABLE `email_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`notification_type` text NOT NULL,
	`contract_version` integer NOT NULL,
	`recipient_email` text COLLATE NOCASE NOT NULL,
	`variables_ciphertext` text,
	`variables_expires_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`provider_message_id` text,
	`last_error_json` text,
	`locked_by` text,
	`locked_until` text,
	`accepted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`customer_id`) REFERENCES `customers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_email_deliveries_contract_version" CHECK("email_deliveries"."contract_version" >= 1),
	CONSTRAINT "ck_email_deliveries_status" CHECK("email_deliveries"."status" in (
        'pending', 'processing', 'waiting_configuration', 'retry_scheduled',
        'accepted', 'failed', 'expired'
      )),
	CONSTRAINT "ck_email_deliveries_attempt_count" CHECK("email_deliveries"."attempt_count" >= 0),
	CONSTRAINT "ck_email_deliveries_last_error_json" CHECK("email_deliveries"."last_error_json" is null
        or (json_valid("email_deliveries"."last_error_json") and json_type("email_deliveries"."last_error_json") = 'object')),
	CONSTRAINT "ck_email_deliveries_lock" CHECK(("email_deliveries"."status" = 'processing'
          and "email_deliveries"."locked_by" is not null
          and "email_deliveries"."locked_until" is not null)
        or ("email_deliveries"."status" <> 'processing'
          and "email_deliveries"."locked_by" is null
          and "email_deliveries"."locked_until" is null)),
	CONSTRAINT "ck_email_deliveries_acceptance" CHECK(("email_deliveries"."status" = 'accepted'
          and "email_deliveries"."provider_message_id" is not null
          and "email_deliveries"."accepted_at" is not null
          and "email_deliveries"."variables_ciphertext" is null
          and "email_deliveries"."last_error_json" is null)
        or ("email_deliveries"."status" <> 'accepted'
          and "email_deliveries"."provider_message_id" is null
          and "email_deliveries"."accepted_at" is null)),
	CONSTRAINT "ck_email_deliveries_variables" CHECK(("email_deliveries"."status" in ('accepted', 'expired') and "email_deliveries"."variables_ciphertext" is null)
        or ("email_deliveries"."status" not in ('accepted', 'expired') and "email_deliveries"."variables_ciphertext" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_email_deliveries_status_schedule` ON `email_deliveries` (`account_id`,`status`,`next_attempt_at`,`locked_until`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_email_deliveries_customer` ON `email_deliveries` (`account_id`,`customer_id`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_deliveries_account_id` ON `email_deliveries` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_deliveries_customer_id` ON `email_deliveries` (`account_id`,`customer_id`,`id`);--> statement-breakpoint
CREATE TABLE `email_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`credential_ciphertext` text NOT NULL,
	`default_from_email` text COLLATE NOCASE NOT NULL,
	`default_from_name` text,
	`reply_to_email` text COLLATE NOCASE,
	`max_automatic_attempts` integer DEFAULT 4 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_email_integrations_provider" CHECK("email_integrations"."provider" = 'resend'),
	CONSTRAINT "ck_email_integrations_max_attempts" CHECK("email_integrations"."max_automatic_attempts" between 1 and 20),
	CONSTRAINT "ck_email_integrations_status" CHECK("email_integrations"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_integrations_active_account` ON `email_integrations` (`account_id`) WHERE "email_integrations"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_email_integrations_account_status` ON `email_integrations` (`account_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_integrations_account_id` ON `email_integrations` (`account_id`,`id`);--> statement-breakpoint
CREATE TABLE `email_template_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`email_integration_id` text NOT NULL,
	`notification_type` text NOT NULL,
	`contract_version` integer NOT NULL,
	`provider_template_ref` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`email_integration_id`) REFERENCES `email_integrations`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_email_template_bindings_contract_version" CHECK("email_template_bindings"."contract_version" >= 1),
	CONSTRAINT "ck_email_template_bindings_template_ref" CHECK(length(trim("email_template_bindings"."provider_template_ref")) > 0),
	CONSTRAINT "ck_email_template_bindings_status" CHECK("email_template_bindings"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `idx_email_template_bindings_lookup` ON `email_template_bindings` (`account_id`,`email_integration_id`,`notification_type`,`contract_version`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_template_bindings_account_id` ON `email_template_bindings` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_template_bindings_integration_id` ON `email_template_bindings` (`account_id`,`email_integration_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_template_bindings_contract` ON `email_template_bindings` (`account_id`,`email_integration_id`,`notification_type`);--> statement-breakpoint
DROP TABLE `outbound_attempts`;--> statement-breakpoint
DROP TABLE `outbound_deliveries`;--> statement-breakpoint
DROP TABLE `outbound_endpoints`;--> statement-breakpoint
DROP TABLE `system_issue_inbound_events`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_system_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`category` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`operation` text NOT NULL,
	`error_code` text NOT NULL,
	`error_detail_json` text NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_system_issues_category" CHECK("__new_system_issues"."category" in ('billing', 'webhook', 'email')),
	CONSTRAINT "ck_system_issues_occurrence_count" CHECK("__new_system_issues"."occurrence_count" >= 1),
	CONSTRAINT "ck_system_issues_seen_order" CHECK("__new_system_issues"."last_seen_at" >= "__new_system_issues"."first_seen_at"),
	CONSTRAINT "ck_system_issues_error_detail_json" CHECK(json_valid("__new_system_issues"."error_detail_json") and json_type("__new_system_issues"."error_detail_json") = 'object')
);
--> statement-breakpoint
INSERT INTO `__new_system_issues`(
	"id", "account_id", "category", "source_type", "source_id", "operation",
	"error_code", "error_detail_json", "occurrence_count", "first_seen_at", "last_seen_at"
) SELECT
	"id", "account_id", 'billing', 'billing_provider', "billing_provider_id", "capability",
	"issue_code", "last_error_detail_json", "occurrence_count", "first_seen_at", "last_seen_at"
FROM `system_issues`;--> statement-breakpoint
DROP TABLE `system_issues`;--> statement-breakpoint
ALTER TABLE `__new_system_issues` RENAME TO `system_issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_system_issues_recent` ON `system_issues` (`account_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_system_issues_source` ON `system_issues` (`account_id`,`category`,`source_type`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_system_issues_account_id` ON `system_issues` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_system_issues_identity` ON `system_issues` (`account_id`,`category`,`source_type`,`source_id`,`operation`,`error_code`);--> statement-breakpoint
DROP TRIGGER `trg_billing_offers_lock_verified_mapping`;--> statement-breakpoint
DROP TRIGGER `trg_checkout_verifications_require_draft_sandbox`;--> statement-breakpoint
DROP TRIGGER `trg_checkout_verifications_immutable_identity`;--> statement-breakpoint
CREATE TABLE `__new_billing_checkout_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`billing_offer_id` text NOT NULL,
	`requested_by_user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`external_transaction_id` text,
	`license_id` text,
	`delivery_id` text,
	`expires_at` text NOT NULL,
	`completed_at` text,
	`last_error_code` text,
	`last_error_detail` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`billing_offer_id`) REFERENCES `billing_offers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`requested_by_user_id`) REFERENCES `users`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`license_id`) REFERENCES `licenses`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`delivery_id`) REFERENCES `email_deliveries`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_billing_checkout_verifications_status" CHECK("__new_billing_checkout_verifications"."status" in ('pending', 'delivery_pending', 'completed', 'needs_attention', 'expired')),
	CONSTRAINT "ck_billing_checkout_verifications_expiry" CHECK("__new_billing_checkout_verifications"."expires_at" > "__new_billing_checkout_verifications"."created_at"),
	CONSTRAINT "ck_billing_checkout_verifications_evidence" CHECK("__new_billing_checkout_verifications"."status" not in ('delivery_pending', 'completed')
        or ("__new_billing_checkout_verifications"."external_transaction_id" is not null
          and "__new_billing_checkout_verifications"."license_id" is not null
          and "__new_billing_checkout_verifications"."delivery_id" is not null)),
	CONSTRAINT "ck_billing_checkout_verifications_completed" CHECK(("__new_billing_checkout_verifications"."status" = 'completed' and "__new_billing_checkout_verifications"."completed_at" is not null)
        or ("__new_billing_checkout_verifications"."status" <> 'completed' and "__new_billing_checkout_verifications"."completed_at" is null)),
	CONSTRAINT "ck_billing_checkout_verifications_expired" CHECK("__new_billing_checkout_verifications"."status" <> 'expired'
        or ("__new_billing_checkout_verifications"."external_transaction_id" is null
          and "__new_billing_checkout_verifications"."license_id" is null
          and "__new_billing_checkout_verifications"."delivery_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_billing_checkout_verifications`("id", "account_id", "billing_offer_id", "requested_by_user_id", "token_hash", "status", "external_transaction_id", "license_id", "delivery_id", "expires_at", "completed_at", "last_error_code", "last_error_detail", "created_at", "updated_at") SELECT "id", "account_id", "billing_offer_id", "requested_by_user_id", "token_hash", "status", "external_transaction_id", "license_id", "delivery_id", "expires_at", "completed_at", "last_error_code", "last_error_detail", "created_at", "updated_at" FROM `billing_checkout_verifications`;--> statement-breakpoint
DROP TABLE `billing_checkout_verifications`;--> statement-breakpoint
ALTER TABLE `__new_billing_checkout_verifications` RENAME TO `billing_checkout_verifications`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_checkout_verifications_transaction` ON `billing_checkout_verifications` (`account_id`,`billing_offer_id`,`external_transaction_id`) WHERE "billing_checkout_verifications"."external_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_billing_checkout_verifications_status_expiry` ON `billing_checkout_verifications` (`account_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_checkout_verifications_offer` ON `billing_checkout_verifications` (`account_id`,`billing_offer_id`,"completed_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_checkout_verifications_account_id` ON `billing_checkout_verifications` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_checkout_verifications_token_hash` ON `billing_checkout_verifications` (`token_hash`);--> statement-breakpoint
CREATE TRIGGER trg_billing_offers_lock_verified_mapping
BEFORE UPDATE OF account_id, billing_provider_id, external_price_id,
    product_id, license_plan_id, purchase_type ON billing_offers
WHEN EXISTS (
    SELECT 1
    FROM billing_checkout_verifications AS verification
    WHERE verification.account_id = OLD.account_id
      AND verification.billing_offer_id = OLD.id
)
BEGIN
    SELECT RAISE(ABORT, 'verified_billing_offer_mapping_immutable');
END;--> statement-breakpoint
CREATE TRIGGER trg_checkout_verifications_require_draft_sandbox
BEFORE INSERT ON billing_checkout_verifications
BEGIN
    SELECT (CASE WHEN NOT EXISTS (
        SELECT 1
        FROM billing_offers AS offer
        JOIN billing_providers AS provider
          ON provider.account_id = NEW.account_id
         AND provider.id = offer.billing_provider_id
        WHERE offer.account_id = NEW.account_id
          AND offer.id = NEW.billing_offer_id
          AND offer.status = 'draft'
          AND provider.environment = 'sandbox'
    ) THEN RAISE(ABORT, 'checkout_verification_requires_draft_sandbox_offer') END);
END;--> statement-breakpoint
CREATE TRIGGER trg_checkout_verifications_immutable_identity
BEFORE UPDATE OF id, account_id, billing_offer_id, requested_by_user_id,
    token_hash, expires_at, created_at
ON billing_checkout_verifications
WHEN NEW.id IS NOT OLD.id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.billing_offer_id IS NOT OLD.billing_offer_id
  OR NEW.requested_by_user_id IS NOT OLD.requested_by_user_id
  OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'checkout_verification_identity_immutable');
END;--> statement-breakpoint
CREATE TABLE `__new_customer_login_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	`delivery_id` text NOT NULL,
	`requested_ip` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`customer_id`) REFERENCES `customers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`customer_id`,`delivery_id`) REFERENCES `email_deliveries`(`account_id`,`customer_id`,`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_customer_login_challenges`("id", "account_id", "customer_id", "token_hash", "expires_at", "consumed_at", "revoked_at", "delivery_id", "requested_ip", "created_at") SELECT "id", "account_id", "customer_id", "token_hash", "expires_at", "consumed_at", "revoked_at", "delivery_id", "requested_ip", "created_at" FROM `customer_login_challenges`;--> statement-breakpoint
DROP TABLE `customer_login_challenges`;--> statement-breakpoint
ALTER TABLE `__new_customer_login_challenges` RENAME TO `customer_login_challenges`;--> statement-breakpoint
CREATE INDEX `idx_customer_login_challenges_customer` ON `customer_login_challenges` (`account_id`,`customer_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_customer_login_challenges_lookup` ON `customer_login_challenges` (`account_id`,`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_customer_login_challenges_expiry` ON `customer_login_challenges` (`account_id`,`expires_at`,`consumed_at`,`revoked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_login_challenges_account_id` ON `customer_login_challenges` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_login_challenges_customer_id` ON `customer_login_challenges` (`account_id`,`customer_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_login_challenges_token_hash` ON `customer_login_challenges` (`token_hash`);--> statement-breakpoint
CREATE TABLE `__new_inbound_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`billing_provider_id` text NOT NULL,
	`external_event_id` text NOT NULL,
	`external_event_type` text NOT NULL,
	`external_customer_id` text,
	`external_transaction_id` text,
	`external_subscription_id` text,
	`external_adjustment_id` text,
	`external_occurred_at` text,
	`payload_ciphertext` text,
	`payload_hash` text NOT NULL,
	`payload_expires_at` text NOT NULL,
	`payload_cleared_at` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_until` text,
	`result_type` text,
	`result_reference_id` text,
	`last_error_code` text,
	`last_error_detail` text,
	`received_at` text NOT NULL,
	`processed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`billing_provider_id`) REFERENCES `billing_providers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_inbound_events_status" CHECK("__new_inbound_events"."status" in ('pending', 'processing', 'processed', 'failed', 'needs_attention')),
	CONSTRAINT "ck_inbound_events_attempt_count" CHECK("__new_inbound_events"."attempt_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_inbound_events`("id", "account_id", "billing_provider_id", "external_event_id", "external_event_type", "external_customer_id", "external_transaction_id", "external_subscription_id", "external_adjustment_id", "external_occurred_at", "payload_ciphertext", "payload_hash", "payload_expires_at", "payload_cleared_at", "status", "attempt_count", "next_attempt_at", "locked_by", "locked_until", "result_type", "result_reference_id", "last_error_code", "last_error_detail", "received_at", "processed_at", "updated_at") SELECT "id", "account_id", "billing_provider_id", "external_event_id", "external_event_type", "external_customer_id", "external_transaction_id", "external_subscription_id", "external_adjustment_id", "external_occurred_at", "payload_ciphertext", "payload_hash", "payload_expires_at", "payload_cleared_at", "status", "attempt_count", "next_attempt_at", "locked_by", "locked_until", "result_type", "result_reference_id", "last_error_code", "last_error_detail", "received_at", "processed_at", "updated_at" FROM `inbound_events`;--> statement-breakpoint
DROP TABLE `inbound_events`;--> statement-breakpoint
ALTER TABLE `__new_inbound_events` RENAME TO `inbound_events`;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_status_schedule` ON `inbound_events` (`account_id`,`status`,`next_attempt_at`,`locked_until`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_inbound_events_provider_type` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_event_type`,"received_at" desc);--> statement-breakpoint
CREATE INDEX `idx_inbound_events_customer` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_customer_id`,"received_at" desc) WHERE "inbound_events"."external_customer_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_transaction` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_transaction_id`,"received_at" desc) WHERE "inbound_events"."external_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_subscription` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_subscription_id`,"received_at" desc) WHERE "inbound_events"."external_subscription_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_adjustment` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_adjustment_id`,"received_at" desc) WHERE "inbound_events"."external_adjustment_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_payload_retention` ON `inbound_events` (`payload_expires_at`,`id`) WHERE "inbound_events"."payload_ciphertext" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inbound_events_account_id` ON `inbound_events` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inbound_events_external` ON `inbound_events` (`billing_provider_id`,`external_event_id`);--> statement-breakpoint
CREATE TABLE `__new_license_key_rotations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`license_id` text NOT NULL,
	`from_version` integer NOT NULL,
	`to_version` integer NOT NULL,
	`reason` text NOT NULL,
	`revoked_activations` integer DEFAULT false NOT NULL,
	`initiated_by_user_id` text,
	`initiated_by_customer_id` text,
	`delivery_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`license_id`) REFERENCES `licenses`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`initiated_by_user_id`) REFERENCES `users`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`initiated_by_customer_id`) REFERENCES `customers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`delivery_id`) REFERENCES `email_deliveries`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_license_key_rotations_from" CHECK("__new_license_key_rotations"."from_version" >= 1),
	CONSTRAINT "ck_license_key_rotations_to" CHECK("__new_license_key_rotations"."to_version" > "__new_license_key_rotations"."from_version"),
	CONSTRAINT "ck_license_key_rotations_reason" CHECK("__new_license_key_rotations"."reason" in ('recovery', 'security_reset', 'admin')),
	CONSTRAINT "ck_license_key_rotations_revoked" CHECK("__new_license_key_rotations"."revoked_activations" in (0, 1)),
	CONSTRAINT "ck_license_key_rotations_initiator" CHECK("__new_license_key_rotations"."initiated_by_user_id" is null or "__new_license_key_rotations"."initiated_by_customer_id" is null)
);
--> statement-breakpoint
INSERT INTO `__new_license_key_rotations`("id", "account_id", "license_id", "from_version", "to_version", "reason", "revoked_activations", "initiated_by_user_id", "initiated_by_customer_id", "delivery_id", "created_at") SELECT "id", "account_id", "license_id", "from_version", "to_version", "reason", "revoked_activations", "initiated_by_user_id", "initiated_by_customer_id", "delivery_id", "created_at" FROM `license_key_rotations`;--> statement-breakpoint
DROP TABLE `license_key_rotations`;--> statement-breakpoint
ALTER TABLE `__new_license_key_rotations` RENAME TO `license_key_rotations`;--> statement-breakpoint
CREATE INDEX `idx_license_key_rotations_license` ON `license_key_rotations` (`account_id`,`license_id`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_license_key_rotations_account_id` ON `license_key_rotations` (`account_id`,`id`);
