DROP TRIGGER `trg_billing_offers_lock_verified_mapping`;--> statement-breakpoint
DROP TRIGGER `trg_checkout_verifications_require_draft_sandbox`;--> statement-breakpoint
DROP TRIGGER `trg_checkout_verifications_immutable_identity`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "ck_billing_checkout_verifications_status" CHECK("__new_billing_checkout_verifications"."status" in ('pending', 'delivery_pending', 'completed', 'needs_attention', 'expired', 'cancelled')),
	CONSTRAINT "ck_billing_checkout_verifications_expiry" CHECK("__new_billing_checkout_verifications"."expires_at" > "__new_billing_checkout_verifications"."created_at"),
	CONSTRAINT "ck_billing_checkout_verifications_evidence" CHECK("__new_billing_checkout_verifications"."status" not in ('delivery_pending', 'completed')
        or ("__new_billing_checkout_verifications"."external_transaction_id" is not null
          and "__new_billing_checkout_verifications"."license_id" is not null
          and "__new_billing_checkout_verifications"."delivery_id" is not null)),
	CONSTRAINT "ck_billing_checkout_verifications_completed" CHECK(("__new_billing_checkout_verifications"."status" = 'completed' and "__new_billing_checkout_verifications"."completed_at" is not null)
        or ("__new_billing_checkout_verifications"."status" <> 'completed' and "__new_billing_checkout_verifications"."completed_at" is null))
);
--> statement-breakpoint
INSERT INTO `__new_billing_checkout_verifications`("id", "account_id", "billing_offer_id", "requested_by_user_id", "token_hash", "status", "external_transaction_id", "license_id", "delivery_id", "expires_at", "completed_at", "last_error_code", "last_error_detail", "created_at", "updated_at") SELECT "id", "account_id", "billing_offer_id", "requested_by_user_id", "token_hash", "status", "external_transaction_id", "license_id", "delivery_id", "expires_at", "completed_at", "last_error_code", "last_error_detail", "created_at", "updated_at" FROM `billing_checkout_verifications`;--> statement-breakpoint
DROP TABLE `billing_checkout_verifications`;--> statement-breakpoint
ALTER TABLE `__new_billing_checkout_verifications` RENAME TO `billing_checkout_verifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
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
CREATE TABLE `__new_email_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`notification_type` text NOT NULL,
	`contract_version` integer NOT NULL,
	`recipient_email` text COLLATE NOCASE NOT NULL,
	`variables_ciphertext` text,
	`send_expires_at` text,
	`variables_expires_at` text,
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
	CONSTRAINT "ck_email_deliveries_contract_version" CHECK("__new_email_deliveries"."contract_version" >= 1),
	CONSTRAINT "ck_email_deliveries_status" CHECK("__new_email_deliveries"."status" in (
        'pending', 'processing', 'waiting_configuration', 'retry_scheduled',
        'accepted', 'failed', 'expired', 'cancelled'
      )),
	CONSTRAINT "ck_email_deliveries_attempt_count" CHECK("__new_email_deliveries"."attempt_count" >= 0),
	CONSTRAINT "ck_email_deliveries_last_error_json" CHECK("__new_email_deliveries"."last_error_json" is null
        or (json_valid("__new_email_deliveries"."last_error_json") and json_type("__new_email_deliveries"."last_error_json") = 'object')),
	CONSTRAINT "ck_email_deliveries_lock" CHECK(("__new_email_deliveries"."status" = 'processing'
          and "__new_email_deliveries"."locked_by" is not null
          and "__new_email_deliveries"."locked_until" is not null)
        or ("__new_email_deliveries"."status" <> 'processing'
          and "__new_email_deliveries"."locked_by" is null
          and "__new_email_deliveries"."locked_until" is null)),
	CONSTRAINT "ck_email_deliveries_acceptance" CHECK(("__new_email_deliveries"."status" = 'accepted'
          and "__new_email_deliveries"."provider_message_id" is not null
          and "__new_email_deliveries"."accepted_at" is not null
          and "__new_email_deliveries"."last_error_json" is null)
        or ("__new_email_deliveries"."status" <> 'accepted'
          and "__new_email_deliveries"."provider_message_id" is null
          and "__new_email_deliveries"."accepted_at" is null)),
	CONSTRAINT "ck_email_deliveries_variables" CHECK(("__new_email_deliveries"."status" in ('expired', 'cancelled') and "__new_email_deliveries"."variables_ciphertext" is null)
        or ("__new_email_deliveries"."status" in (
          'pending', 'processing', 'waiting_configuration', 'retry_scheduled', 'failed'
        ) and "__new_email_deliveries"."variables_ciphertext" is not null)
        or ("__new_email_deliveries"."status" = 'accepted')),
	CONSTRAINT "ck_email_deliveries_retention" CHECK(("__new_email_deliveries"."status" = 'accepted' and "__new_email_deliveries"."variables_expires_at" is not null)
        or ("__new_email_deliveries"."status" <> 'accepted' and "__new_email_deliveries"."variables_expires_at" is null))
);
--> statement-breakpoint
INSERT INTO `__new_email_deliveries`("id", "account_id", "customer_id", "notification_type", "contract_version", "recipient_email", "variables_ciphertext", "send_expires_at", "variables_expires_at", "status", "attempt_count", "next_attempt_at", "provider_message_id", "last_error_json", "locked_by", "locked_until", "accepted_at", "created_at", "updated_at")
SELECT "id", "account_id", "customer_id", "notification_type", "contract_version", "recipient_email", "variables_ciphertext",
       CASE WHEN "status" IN ('accepted', 'expired') THEN NULL ELSE "variables_expires_at" END,
       CASE WHEN "status" = 'accepted' THEN "variables_expires_at" ELSE NULL END,
       "status", "attempt_count", "next_attempt_at", "provider_message_id", "last_error_json", "locked_by", "locked_until", "accepted_at", "created_at", "updated_at"
FROM `email_deliveries`;--> statement-breakpoint
DROP TABLE `email_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_email_deliveries` RENAME TO `email_deliveries`;--> statement-breakpoint
CREATE INDEX `idx_email_deliveries_status_schedule` ON `email_deliveries` (`account_id`,`status`,`next_attempt_at`,`locked_until`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_email_deliveries_customer` ON `email_deliveries` (`account_id`,`customer_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_email_deliveries_payload_retention` ON `email_deliveries` (`variables_expires_at`,`id`) WHERE "email_deliveries"."status" = 'accepted' and "email_deliveries"."variables_ciphertext" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_deliveries_account_id` ON `email_deliveries` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_deliveries_customer_id` ON `email_deliveries` (`account_id`,`customer_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_system_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`category` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`operation` text NOT NULL,
	`error_code` text NOT NULL,
	`error_detail_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`processed_at` text,
	`processed_by_user_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`processed_by_user_id`) REFERENCES `users`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_system_issues_category" CHECK("__new_system_issues"."category" in ('billing', 'webhook', 'email')),
	CONSTRAINT "ck_system_issues_status" CHECK("__new_system_issues"."status" in ('pending', 'processed')),
	CONSTRAINT "ck_system_issues_occurrence_count" CHECK("__new_system_issues"."occurrence_count" >= 1),
	CONSTRAINT "ck_system_issues_seen_order" CHECK("__new_system_issues"."last_seen_at" >= "__new_system_issues"."first_seen_at"),
	CONSTRAINT "ck_system_issues_error_detail_json" CHECK(json_valid("__new_system_issues"."error_detail_json") and json_type("__new_system_issues"."error_detail_json") = 'object'),
	CONSTRAINT "ck_system_issues_processing" CHECK(("__new_system_issues"."status" = 'pending'
          and "__new_system_issues"."processed_at" is null
          and "__new_system_issues"."processed_by_user_id" is null)
        or ("__new_system_issues"."status" = 'processed'
          and "__new_system_issues"."processed_at" is not null
          and "__new_system_issues"."processed_by_user_id" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_system_issues`("id", "account_id", "category", "source_type", "source_id", "operation", "error_code", "error_detail_json", "status", "occurrence_count", "first_seen_at", "last_seen_at", "processed_at", "processed_by_user_id")
SELECT "id", "account_id", "category", "source_type", "source_id", "operation", "error_code", "error_detail_json", 'pending', "occurrence_count", "first_seen_at", "last_seen_at", NULL, NULL
FROM `system_issues`;--> statement-breakpoint
DROP TABLE `system_issues`;--> statement-breakpoint
ALTER TABLE `__new_system_issues` RENAME TO `system_issues`;--> statement-breakpoint
CREATE INDEX `idx_system_issues_recent` ON `system_issues` (`account_id`,`status`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_system_issues_source` ON `system_issues` (`account_id`,`category`,`source_type`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_system_issues_account_id` ON `system_issues` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_system_issues_identity` ON `system_issues` (`account_id`,`category`,`source_type`,`source_id`,`operation`,`error_code`);
--> statement-breakpoint
CREATE TRIGGER trg_licenses_manual_issue_invariant
BEFORE INSERT ON licenses
WHEN NEW.source = 'manual'
  AND NOT EXISTS (
    SELECT 1
    FROM license_plans AS plan
    JOIN products AS product
      ON product.account_id = plan.account_id
     AND product.id = plan.product_id
    JOIN customers AS customer
      ON customer.account_id = plan.account_id
     AND customer.id = NEW.customer_id
    WHERE plan.account_id = NEW.account_id
      AND plan.id = NEW.plan_id
      AND plan.product_id = NEW.product_id
      AND plan.revision = NEW.plan_revision
      AND plan.status = 'active'
      AND product.status = 'active'
      AND customer.status = 'active'
      AND (
        NEW.credential_mode <> 'signed'
        OR EXISTS (
          SELECT 1 FROM signing_keys AS signing_key
          WHERE signing_key.account_id = NEW.account_id
            AND signing_key.product_id = NEW.product_id
            AND signing_key.status = 'active'
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'LICENSE_MANUAL_ISSUE_INVARIANT');
END;
