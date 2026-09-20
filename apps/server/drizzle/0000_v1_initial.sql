CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`default_subscription_payment_grace_seconds` integer DEFAULT 432000 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ck_accounts_default_subscription_payment_grace_seconds" CHECK("accounts"."default_subscription_payment_grace_seconds" >= 0),
	CONSTRAINT "ck_accounts_status" CHECK("accounts"."status" in ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_accounts_slug` ON `accounts` (`slug`);--> statement-breakpoint
CREATE TABLE `activations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`license_id` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`machine_token_hash` text NOT NULL,
	`name` text,
	`platform` text,
	`first_ip` text,
	`status` text DEFAULT 'active' NOT NULL,
	`activated_at` text NOT NULL,
	`last_validated_at` text,
	`deactivated_at` text,
	`revoked_at` text,
	`revoke_reason` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`license_id`) REFERENCES `licenses`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_activations_status" CHECK("activations"."status" in ('active', 'deactivated', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_activations_license_status` ON `activations` (`account_id`,`license_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_activations_token_hash` ON `activations` (`account_id`,`machine_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_activations_active_fingerprint` ON `activations` (`account_id`,`license_id`,`fingerprint_hash`) WHERE "activations"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `uq_activations_account_id` ON `activations` (`account_id`,`id`);--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_token_hash` text NOT NULL,
	`csrf_token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`user_id`) REFERENCES `users`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_admin_sessions_user_expiry` ON `admin_sessions` (`account_id`,`user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_admin_sessions_lookup` ON `admin_sessions` (`account_id`,`session_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_admin_sessions_account_id` ON `admin_sessions` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_admin_sessions_token_hash` ON `admin_sessions` (`session_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_admin_sessions_csrf_token_hash` ON `admin_sessions` (`csrf_token_hash`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_user_id` text,
	`actor_customer_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`request_id` text,
	`details_redacted_json` text DEFAULT '{}' NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`actor_user_id`) REFERENCES `users`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`actor_customer_id`) REFERENCES `customers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_audit_logs_actor_type" CHECK("audit_logs"."actor_type" in ('user', 'customer', 'system')),
	CONSTRAINT "ck_audit_logs_details_json" CHECK(json_valid("audit_logs"."details_redacted_json")),
	CONSTRAINT "ck_audit_logs_actor" CHECK(("audit_logs"."actor_type" = 'user'
          and "audit_logs"."actor_user_id" is not null
          and "audit_logs"."actor_customer_id" is null)
        or ("audit_logs"."actor_type" = 'customer'
          and "audit_logs"."actor_customer_id" is not null
          and "audit_logs"."actor_user_id" is null)
        or ("audit_logs"."actor_type" = 'system'
          and "audit_logs"."actor_user_id" is null
          and "audit_logs"."actor_customer_id" is null))
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_account_created` ON `audit_logs` (`account_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_resource` ON `audit_logs` (`account_id`,`resource_type`,`resource_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_action` ON `audit_logs` (`account_id`,`action`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_audit_logs_account_id` ON `audit_logs` (`account_id`,`id`);--> statement-breakpoint
CREATE TABLE `billing_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`billing_provider_id` text NOT NULL,
	`license_id` text,
	`external_adjustment_id` text NOT NULL,
	`external_transaction_id` text NOT NULL,
	`external_subscription_id` text,
	`external_customer_id` text NOT NULL,
	`provider_action` text NOT NULL,
	`adjustment_type` text,
	`provider_status` text NOT NULL,
	`currency_code` text NOT NULL,
	`total_amount` text NOT NULL,
	`provider_reason` text,
	`automatic_effect` text DEFAULT 'none' NOT NULL,
	`review_status` text NOT NULL,
	`resolution_action` text,
	`resolution_reason` text,
	`resolved_by_user_id` text,
	`resolved_at` text,
	`last_external_occurred_at` text NOT NULL,
	`last_external_event_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`billing_provider_id`) REFERENCES `billing_providers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`license_id`) REFERENCES `licenses`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`resolved_by_user_id`) REFERENCES `users`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_billing_adjustments_action" CHECK("billing_adjustments"."provider_action" in (
        'credit', 'refund', 'chargeback', 'chargeback_reverse',
        'chargeback_warning', 'chargeback_warning_reverse', 'credit_reverse'
      )),
	CONSTRAINT "ck_billing_adjustments_type" CHECK("billing_adjustments"."adjustment_type" is null or "billing_adjustments"."adjustment_type" in ('full', 'partial')),
	CONSTRAINT "ck_billing_adjustments_provider_status" CHECK("billing_adjustments"."provider_status" in ('pending_approval', 'approved', 'rejected', 'reversed')),
	CONSTRAINT "ck_billing_adjustments_automatic_effect" CHECK("billing_adjustments"."automatic_effect" in ('none', 'license_suspended')),
	CONSTRAINT "ck_billing_adjustments_review_status" CHECK("billing_adjustments"."review_status" in ('not_required', 'open', 'resolved')),
	CONSTRAINT "ck_billing_adjustments_resolution_action" CHECK("billing_adjustments"."resolution_action" is null or "billing_adjustments"."resolution_action" in (
        'no_action', 'keep_suspended', 'reinstate', 'revoke', 'security_reset'
      )),
	CONSTRAINT "ck_billing_adjustments_effect_license" CHECK("billing_adjustments"."automatic_effect" = 'none' or "billing_adjustments"."license_id" is not null),
	CONSTRAINT "ck_billing_adjustments_not_required" CHECK("billing_adjustments"."review_status" <> 'not_required' or "billing_adjustments"."automatic_effect" = 'none'),
	CONSTRAINT "ck_billing_adjustments_resolution" CHECK(("billing_adjustments"."review_status" in ('not_required', 'open')
          and "billing_adjustments"."resolution_action" is null
          and "billing_adjustments"."resolution_reason" is null
          and "billing_adjustments"."resolved_by_user_id" is null
          and "billing_adjustments"."resolved_at" is null)
        or ("billing_adjustments"."review_status" = 'resolved'
          and "billing_adjustments"."resolution_action" is not null
          and "billing_adjustments"."resolution_reason" is not null
          and "billing_adjustments"."resolved_by_user_id" is not null
          and "billing_adjustments"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_billing_adjustments_review` ON `billing_adjustments` (`account_id`,`review_status`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_billing_adjustments_transaction` ON `billing_adjustments` (`account_id`,`billing_provider_id`,`external_transaction_id`,"updated_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_adjustments_account_id` ON `billing_adjustments` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_adjustments_external` ON `billing_adjustments` (`billing_provider_id`,`external_adjustment_id`);--> statement-breakpoint
CREATE TABLE `billing_checkout_verifications` (
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
	FOREIGN KEY (`account_id`,`license_id`,`delivery_id`) REFERENCES `outbound_deliveries`(`account_id`,`license_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_billing_checkout_verifications_status" CHECK("billing_checkout_verifications"."status" in ('pending', 'delivery_pending', 'completed', 'needs_attention', 'expired')),
	CONSTRAINT "ck_billing_checkout_verifications_expiry" CHECK("billing_checkout_verifications"."expires_at" > "billing_checkout_verifications"."created_at"),
	CONSTRAINT "ck_billing_checkout_verifications_evidence" CHECK("billing_checkout_verifications"."status" not in ('delivery_pending', 'completed')
        or ("billing_checkout_verifications"."external_transaction_id" is not null
          and "billing_checkout_verifications"."license_id" is not null
          and "billing_checkout_verifications"."delivery_id" is not null)),
	CONSTRAINT "ck_billing_checkout_verifications_completed" CHECK(("billing_checkout_verifications"."status" = 'completed' and "billing_checkout_verifications"."completed_at" is not null)
        or ("billing_checkout_verifications"."status" <> 'completed' and "billing_checkout_verifications"."completed_at" is null)),
	CONSTRAINT "ck_billing_checkout_verifications_expired" CHECK("billing_checkout_verifications"."status" <> 'expired'
        or ("billing_checkout_verifications"."external_transaction_id" is null
          and "billing_checkout_verifications"."license_id" is null
          and "billing_checkout_verifications"."delivery_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_checkout_verifications_transaction` ON `billing_checkout_verifications` (`account_id`,`billing_offer_id`,`external_transaction_id`) WHERE "billing_checkout_verifications"."external_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_billing_checkout_verifications_status_expiry` ON `billing_checkout_verifications` (`account_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_checkout_verifications_offer` ON `billing_checkout_verifications` (`account_id`,`billing_offer_id`,"completed_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_checkout_verifications_account_id` ON `billing_checkout_verifications` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_checkout_verifications_token_hash` ON `billing_checkout_verifications` (`token_hash`);--> statement-breakpoint
CREATE TABLE `billing_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`billing_provider_id` text NOT NULL,
	`customer_id` text,
	`external_customer_id` text NOT NULL,
	`provider_email` text COLLATE NOCASE NOT NULL,
	`provider_name` text,
	`provider_status` text NOT NULL,
	`link_status` text NOT NULL,
	`last_sync_source` text NOT NULL,
	`external_updated_at` text NOT NULL,
	`last_external_event_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`billing_provider_id`) REFERENCES `billing_providers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`customer_id`) REFERENCES `customers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_billing_customers_provider_status" CHECK("billing_customers"."provider_status" in ('active', 'archived')),
	CONSTRAINT "ck_billing_customers_link_status" CHECK("billing_customers"."link_status" in ('pending', 'linked', 'email_mismatch', 'needs_attention')),
	CONSTRAINT "ck_billing_customers_sync_source" CHECK("billing_customers"."last_sync_source" in ('webhook', 'api', 'reconciliation')),
	CONSTRAINT "ck_billing_customers_link" CHECK(("billing_customers"."customer_id" is null and "billing_customers"."link_status" in ('pending', 'needs_attention'))
        or ("billing_customers"."customer_id" is not null and "billing_customers"."link_status" in ('linked', 'email_mismatch')))
);
--> statement-breakpoint
CREATE INDEX `idx_billing_customers_customer` ON `billing_customers` (`account_id`,`customer_id`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_billing_customers_link_status` ON `billing_customers` (`account_id`,`billing_provider_id`,`link_status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_customers_account_id` ON `billing_customers` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_customers_provider_customer` ON `billing_customers` (`billing_provider_id`,`external_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_customers_account_provider_customer` ON `billing_customers` (`account_id`,`billing_provider_id`,`external_customer_id`);--> statement-breakpoint
CREATE TABLE `billing_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`billing_provider_id` text NOT NULL,
	`external_price_id` text NOT NULL,
	`product_id` text NOT NULL,
	`license_plan_id` text NOT NULL,
	`purchase_type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`billing_provider_id`) REFERENCES `billing_providers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`product_id`) REFERENCES `products`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`product_id`,`license_plan_id`) REFERENCES `license_plans`(`account_id`,`product_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_billing_offers_purchase_type" CHECK("billing_offers"."purchase_type" in ('one_time', 'subscription')),
	CONSTRAINT "ck_billing_offers_status" CHECK("billing_offers"."status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `idx_billing_offers_plan_status` ON `billing_offers` (`account_id`,`license_plan_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_offers_account_id` ON `billing_offers` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_offers_price` ON `billing_offers` (`billing_provider_id`,`external_price_id`);--> statement-breakpoint
CREATE TABLE `billing_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`environment` text NOT NULL,
	`client_side_token` text NOT NULL,
	`webhook_secret_ciphertext` text NOT NULL,
	`api_secret_ciphertext` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_billing_providers_environment" CHECK("billing_providers"."environment" in ('sandbox', 'live')),
	CONSTRAINT "ck_billing_providers_status" CHECK("billing_providers"."status" in ('active', 'disabled')),
	CONSTRAINT "ck_billing_providers_client_side_token" CHECK(("billing_providers"."environment" = 'sandbox' and substr("billing_providers"."client_side_token", 1, 5) = 'test_')
        or ("billing_providers"."environment" = 'live' and substr("billing_providers"."client_side_token", 1, 5) = 'live_'))
);
--> statement-breakpoint
CREATE INDEX `idx_billing_providers_account_status` ON `billing_providers` (`account_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_providers_account_id` ON `billing_providers` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_providers_identity` ON `billing_providers` (`account_id`,`provider`,`environment`);--> statement-breakpoint
CREATE TABLE `billing_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`billing_provider_id` text NOT NULL,
	`license_id` text NOT NULL,
	`external_subscription_id` text NOT NULL,
	`external_customer_id` text NOT NULL,
	`external_price_id` text NOT NULL,
	`status` text NOT NULL,
	`current_period_start` text,
	`current_period_end` text,
	`next_billed_at` text,
	`trial_type` text,
	`trial_started_at` text,
	`trial_ends_at` text,
	`cancel_at_period_end` integer DEFAULT 0 NOT NULL,
	`last_external_occurred_at` text,
	`last_external_event_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`billing_provider_id`) REFERENCES `billing_providers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`billing_provider_id`,`external_customer_id`) REFERENCES `billing_customers`(`account_id`,`billing_provider_id`,`external_customer_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`license_id`) REFERENCES `licenses`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_billing_subscriptions_status" CHECK("billing_subscriptions"."status" in ('trialing', 'active', 'past_due', 'paused', 'canceled')),
	CONSTRAINT "ck_billing_subscriptions_trial_type" CHECK("billing_subscriptions"."trial_type" is null or "billing_subscriptions"."trial_type" = 'free_payment_method_required'),
	CONSTRAINT "ck_billing_subscriptions_cancel" CHECK("billing_subscriptions"."cancel_at_period_end" in (0, 1)),
	CONSTRAINT "ck_billing_subscriptions_trial_fields" CHECK(("billing_subscriptions"."trial_type" is null
          and "billing_subscriptions"."trial_started_at" is null
          and "billing_subscriptions"."trial_ends_at" is null)
        or ("billing_subscriptions"."trial_type" is not null
          and "billing_subscriptions"."trial_started_at" is not null
          and "billing_subscriptions"."trial_ends_at" is not null
          and "billing_subscriptions"."trial_ends_at" > "billing_subscriptions"."trial_started_at")),
	CONSTRAINT "ck_billing_subscriptions_trialing" CHECK("billing_subscriptions"."status" <> 'trialing'
        or ("billing_subscriptions"."trial_type" = 'free_payment_method_required'
          and "billing_subscriptions"."trial_started_at" is not null
          and "billing_subscriptions"."trial_ends_at" is not null
          and "billing_subscriptions"."next_billed_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_billing_subscriptions_status_period` ON `billing_subscriptions` (`account_id`,`status`,`current_period_end`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_subscriptions_account_id` ON `billing_subscriptions` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_subscriptions_external` ON `billing_subscriptions` (`billing_provider_id`,`external_subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_subscriptions_license` ON `billing_subscriptions` (`license_id`);--> statement-breakpoint
CREATE TABLE `customer_login_challenges` (
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
	FOREIGN KEY (`account_id`,`customer_id`,`delivery_id`) REFERENCES `outbound_deliveries`(`account_id`,`customer_id`,`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_customer_login_challenges_customer` ON `customer_login_challenges` (`account_id`,`customer_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_customer_login_challenges_lookup` ON `customer_login_challenges` (`account_id`,`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_customer_login_challenges_expiry` ON `customer_login_challenges` (`account_id`,`expires_at`,`consumed_at`,`revoked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_login_challenges_account_id` ON `customer_login_challenges` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_login_challenges_customer_id` ON `customer_login_challenges` (`account_id`,`customer_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_login_challenges_token_hash` ON `customer_login_challenges` (`token_hash`);--> statement-breakpoint
CREATE TABLE `customer_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`login_challenge_id` text NOT NULL,
	`session_token_hash` text NOT NULL,
	`csrf_token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`customer_id`) REFERENCES `customers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`customer_id`,`login_challenge_id`) REFERENCES `customer_login_challenges`(`account_id`,`customer_id`,`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_customer_sessions_customer_expiry` ON `customer_sessions` (`account_id`,`customer_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_customer_sessions_lookup` ON `customer_sessions` (`account_id`,`session_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_sessions_account_id` ON `customer_sessions` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_sessions_challenge` ON `customer_sessions` (`login_challenge_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_sessions_token_hash` ON `customer_sessions` (`session_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_sessions_csrf_token_hash` ON `customer_sessions` (`csrf_token_hash`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_customers_status" CHECK("customers"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `idx_customers_account_status` ON `customers` (`account_id`,`status`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customers_account_id` ON `customers` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customers_account_email` ON `customers` (`account_id`,`email`);--> statement-breakpoint
CREATE TABLE `inbound_events` (
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
	`blocking_system_issue_id` text,
	`received_at` text NOT NULL,
	`processed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`billing_provider_id`) REFERENCES `billing_providers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`blocking_system_issue_id`) REFERENCES `system_issues`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_inbound_events_status" CHECK("inbound_events"."status" in ('pending', 'processing', 'processed', 'failed', 'needs_attention')),
	CONSTRAINT "ck_inbound_events_attempt_count" CHECK("inbound_events"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_inbound_events_status_schedule` ON `inbound_events` (`account_id`,`status`,`next_attempt_at`,`locked_until`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_inbound_events_provider_type` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_event_type`,"received_at" desc);--> statement-breakpoint
CREATE INDEX `idx_inbound_events_customer` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_customer_id`,"received_at" desc) WHERE "inbound_events"."external_customer_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_transaction` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_transaction_id`,"received_at" desc) WHERE "inbound_events"."external_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_subscription` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_subscription_id`,"received_at" desc) WHERE "inbound_events"."external_subscription_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_adjustment` ON `inbound_events` (`account_id`,`billing_provider_id`,`external_adjustment_id`,"received_at" desc) WHERE "inbound_events"."external_adjustment_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_blocking_issue` ON `inbound_events` (`account_id`,`blocking_system_issue_id`,`status`,`received_at`) WHERE "inbound_events"."blocking_system_issue_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inbound_events_payload_retention` ON `inbound_events` (`payload_expires_at`,`id`) WHERE "inbound_events"."payload_ciphertext" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inbound_events_account_id` ON `inbound_events` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inbound_events_external` ON `inbound_events` (`billing_provider_id`,`external_event_id`);--> statement-breakpoint
CREATE TABLE `license_key_rotations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`license_id` text NOT NULL,
	`from_version` integer NOT NULL,
	`to_version` integer NOT NULL,
	`reason` text NOT NULL,
	`revoked_activations` integer DEFAULT 0 NOT NULL,
	`initiated_by_user_id` text,
	`initiated_by_customer_id` text,
	`delivery_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`license_id`) REFERENCES `licenses`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`initiated_by_user_id`) REFERENCES `users`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`initiated_by_customer_id`) REFERENCES `customers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`license_id`,`delivery_id`) REFERENCES `outbound_deliveries`(`account_id`,`license_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_license_key_rotations_from" CHECK("license_key_rotations"."from_version" >= 1),
	CONSTRAINT "ck_license_key_rotations_to" CHECK("license_key_rotations"."to_version" > "license_key_rotations"."from_version"),
	CONSTRAINT "ck_license_key_rotations_reason" CHECK("license_key_rotations"."reason" in ('recovery', 'security_reset', 'admin')),
	CONSTRAINT "ck_license_key_rotations_revoked" CHECK("license_key_rotations"."revoked_activations" in (0, 1)),
	CONSTRAINT "ck_license_key_rotations_initiator" CHECK("license_key_rotations"."initiated_by_user_id" is null or "license_key_rotations"."initiated_by_customer_id" is null)
);
--> statement-breakpoint
CREATE INDEX `idx_license_key_rotations_license` ON `license_key_rotations` (`account_id`,`license_id`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_license_key_rotations_account_id` ON `license_key_rotations` (`account_id`,`id`);--> statement-breakpoint
CREATE TABLE `license_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`license_model` text NOT NULL,
	`credential_mode` text NOT NULL,
	`default_term_seconds` integer,
	`update_window_seconds` integer,
	`signed_token_ttl_seconds` integer DEFAULT 0 NOT NULL,
	`payment_grace_seconds` integer NOT NULL,
	`max_activations` integer DEFAULT 1 NOT NULL,
	`features_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`product_id`) REFERENCES `products`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_license_plans_revision" CHECK("license_plans"."revision" >= 1),
	CONSTRAINT "ck_license_plans_license_model" CHECK("license_plans"."license_model" in ('perpetual', 'fixed_term', 'subscription')),
	CONSTRAINT "ck_license_plans_credential_mode" CHECK("license_plans"."credential_mode" in ('opaque', 'signed')),
	CONSTRAINT "ck_license_plans_default_term_seconds" CHECK("license_plans"."default_term_seconds" is null or "license_plans"."default_term_seconds" > 0),
	CONSTRAINT "ck_license_plans_update_window_seconds" CHECK("license_plans"."update_window_seconds" is null or "license_plans"."update_window_seconds" > 0),
	CONSTRAINT "ck_license_plans_signed_token_ttl" CHECK("license_plans"."signed_token_ttl_seconds" >= 0),
	CONSTRAINT "ck_license_plans_payment_grace" CHECK("license_plans"."payment_grace_seconds" >= 0),
	CONSTRAINT "ck_license_plans_max_activations" CHECK("license_plans"."max_activations" >= 1),
	CONSTRAINT "ck_license_plans_features_json" CHECK(json_valid("license_plans"."features_json") and json_type("license_plans"."features_json") = 'array'),
	CONSTRAINT "ck_license_plans_status" CHECK("license_plans"."status" in ('active', 'archived')),
	CONSTRAINT "ck_license_plans_term_model" CHECK(("license_plans"."license_model" = 'fixed_term' and "license_plans"."default_term_seconds" is not null)
        or ("license_plans"."license_model" in ('perpetual', 'subscription') and "license_plans"."default_term_seconds" is null)),
	CONSTRAINT "ck_license_plans_update_model" CHECK("license_plans"."license_model" = 'perpetual' or "license_plans"."update_window_seconds" is null),
	CONSTRAINT "ck_license_plans_credential_ttl" CHECK(("license_plans"."credential_mode" = 'opaque' and "license_plans"."signed_token_ttl_seconds" = 0)
        or ("license_plans"."credential_mode" = 'signed' and "license_plans"."signed_token_ttl_seconds" > 0)),
	CONSTRAINT "ck_license_plans_payment_grace_model" CHECK(("license_plans"."license_model" = 'subscription' and "license_plans"."payment_grace_seconds" >= 0)
        or ("license_plans"."license_model" in ('perpetual', 'fixed_term') and "license_plans"."payment_grace_seconds" = 0))
);
--> statement-breakpoint
CREATE INDEX `idx_license_plans_product_status` ON `license_plans` (`account_id`,`product_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_license_plans_account_id` ON `license_plans` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_license_plans_product_id` ON `license_plans` (`account_id`,`product_id`,`id`);--> statement-breakpoint
CREATE TABLE `licenses` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`product_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`license_model` text NOT NULL,
	`renewal_mode` text NOT NULL,
	`credential_mode` text NOT NULL,
	`signed_token_ttl_seconds` integer NOT NULL,
	`payment_grace_seconds` integer NOT NULL,
	`max_activations` integer NOT NULL,
	`features_json` text DEFAULT '[]' NOT NULL,
	`key_hash` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`key_rotated_at` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_billing_provider_id` text,
	`source_external_transaction_id` text,
	`is_checkout_verification` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`status_reason` text,
	`expires_at` text,
	`updates_until` text,
	`suspended_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`customer_id`) REFERENCES `customers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`product_id`) REFERENCES `products`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`product_id`,`plan_id`) REFERENCES `license_plans`(`account_id`,`product_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`source_billing_provider_id`) REFERENCES `billing_providers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_licenses_plan_revision" CHECK("licenses"."plan_revision" >= 1),
	CONSTRAINT "ck_licenses_license_model" CHECK("licenses"."license_model" in ('perpetual', 'fixed_term', 'subscription')),
	CONSTRAINT "ck_licenses_renewal_mode" CHECK("licenses"."renewal_mode" in ('none', 'manual', 'billing')),
	CONSTRAINT "ck_licenses_credential_mode" CHECK("licenses"."credential_mode" in ('opaque', 'signed')),
	CONSTRAINT "ck_licenses_signed_token_ttl" CHECK("licenses"."signed_token_ttl_seconds" >= 0),
	CONSTRAINT "ck_licenses_payment_grace" CHECK("licenses"."payment_grace_seconds" >= 0),
	CONSTRAINT "ck_licenses_max_activations" CHECK("licenses"."max_activations" >= 1),
	CONSTRAINT "ck_licenses_features_json" CHECK(json_valid("licenses"."features_json") and json_type("licenses"."features_json") = 'array'),
	CONSTRAINT "ck_licenses_key_version" CHECK("licenses"."key_version" >= 1),
	CONSTRAINT "ck_licenses_source" CHECK("licenses"."source" in ('manual', 'api', 'payment')),
	CONSTRAINT "ck_licenses_verification" CHECK("licenses"."is_checkout_verification" in (0, 1)),
	CONSTRAINT "ck_licenses_status" CHECK("licenses"."status" in ('active', 'suspended', 'revoked')),
	CONSTRAINT "ck_licenses_expiry_model" CHECK(("licenses"."license_model" = 'perpetual' and "licenses"."expires_at" is null)
        or ("licenses"."license_model" in ('fixed_term', 'subscription') and "licenses"."expires_at" is not null)),
	CONSTRAINT "ck_licenses_update_model" CHECK("licenses"."license_model" = 'perpetual' or "licenses"."updates_until" is null),
	CONSTRAINT "ck_licenses_credential_ttl" CHECK(("licenses"."credential_mode" = 'opaque' and "licenses"."signed_token_ttl_seconds" = 0)
        or ("licenses"."credential_mode" = 'signed' and "licenses"."signed_token_ttl_seconds" > 0)),
	CONSTRAINT "ck_licenses_payment_grace_model" CHECK(("licenses"."license_model" = 'subscription' and "licenses"."payment_grace_seconds" >= 0)
        or ("licenses"."license_model" in ('perpetual', 'fixed_term') and "licenses"."payment_grace_seconds" = 0)),
	CONSTRAINT "ck_licenses_source_reference" CHECK(("licenses"."source" = 'payment'
          and "licenses"."source_billing_provider_id" is not null
          and "licenses"."source_external_transaction_id" is not null)
        or ("licenses"."source" in ('manual', 'api')
          and "licenses"."source_billing_provider_id" is null
          and "licenses"."source_external_transaction_id" is null)),
	CONSTRAINT "ck_licenses_checkout_verification" CHECK("licenses"."is_checkout_verification" = 0
        or ("licenses"."source" = 'payment'
          and "licenses"."status" = 'suspended'
          and "licenses"."status_reason" = 'checkout_verification')),
	CONSTRAINT "ck_licenses_renewal_authority" CHECK(("licenses"."license_model" in ('perpetual', 'fixed_term') and "licenses"."renewal_mode" = 'none')
        or ("licenses"."license_model" = 'subscription'
          and "licenses"."renewal_mode" = 'manual'
          and "licenses"."source" in ('manual', 'api'))
        or ("licenses"."license_model" = 'subscription'
          and "licenses"."renewal_mode" = 'billing'
          and "licenses"."source" = 'payment')),
	CONSTRAINT "ck_licenses_manual_expiry" CHECK("licenses"."renewal_mode" <> 'manual' or "licenses"."expires_at" > "licenses"."created_at"),
	CONSTRAINT "ck_licenses_billing_grace" CHECK("licenses"."renewal_mode" = 'billing' or "licenses"."payment_grace_seconds" = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_licenses_source_transaction` ON `licenses` (`account_id`,`source_billing_provider_id`,`source_external_transaction_id`) WHERE "licenses"."source_billing_provider_id" is not null and "licenses"."source_external_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_licenses_account_status` ON `licenses` (`account_id`,`status`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_licenses_product_plan` ON `licenses` (`account_id`,`product_id`,`plan_id`);--> statement-breakpoint
CREATE INDEX `idx_licenses_customer` ON `licenses` (`account_id`,`customer_id`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_licenses_account_id` ON `licenses` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_licenses_account_key_hash` ON `licenses` (`account_id`,`key_hash`);--> statement-breakpoint
CREATE TABLE `outbound_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`attempt_source` text NOT NULL,
	`outcome` text NOT NULL,
	`http_status` integer,
	`response_body_redacted` text,
	`transport_error_code` text,
	`transport_error_detail` text,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`delivery_id`) REFERENCES `outbound_deliveries`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_outbound_attempts_number" CHECK("outbound_attempts"."attempt_number" >= 1),
	CONSTRAINT "ck_outbound_attempts_source" CHECK("outbound_attempts"."attempt_source" in ('initial', 'automatic_retry', 'manual_retry')),
	CONSTRAINT "ck_outbound_attempts_outcome" CHECK("outbound_attempts"."outcome" in ('accepted', 'http_error', 'transport_error', 'timeout')),
	CONSTRAINT "ck_outbound_attempts_duration" CHECK("outbound_attempts"."duration_ms" >= 0),
	CONSTRAINT "ck_outbound_attempts_sequence" CHECK(("outbound_attempts"."attempt_number" = 1 and "outbound_attempts"."attempt_source" = 'initial')
        or ("outbound_attempts"."attempt_number" > 1
          and "outbound_attempts"."attempt_source" in ('automatic_retry', 'manual_retry')))
);
--> statement-breakpoint
CREATE INDEX `idx_outbound_attempts_delivery` ON `outbound_attempts` (`account_id`,`delivery_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outbound_attempts_account_id` ON `outbound_attempts` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outbound_attempts_delivery_number` ON `outbound_attempts` (`delivery_id`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `outbound_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`endpoint_id` text,
	`customer_id` text,
	`license_id` text,
	`event_type` text NOT NULL,
	`recipient_email` text COLLATE NOCASE,
	`idempotency_key` text NOT NULL,
	`target_url` text,
	`signing_secret_ciphertext` text,
	`payload_ciphertext` text,
	`payload_expires_at` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`automatic_attempt_count` integer DEFAULT 0 NOT NULL,
	`max_automatic_attempts` integer NOT NULL,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_until` text,
	`last_error_code` text,
	`last_error_detail` text,
	`accepted_at` text,
	`payload_cleared_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`endpoint_id`) REFERENCES `outbound_endpoints`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`customer_id`) REFERENCES `customers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`license_id`) REFERENCES `licenses`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_outbound_deliveries_status" CHECK("outbound_deliveries"."status" in (
        'blocked_configuration', 'pending', 'processing', 'accepted',
        'retry_scheduled', 'failed', 'payload_expired'
      )),
	CONSTRAINT "ck_outbound_deliveries_attempt_count" CHECK("outbound_deliveries"."attempt_count" >= 0),
	CONSTRAINT "ck_outbound_deliveries_automatic_attempt_count" CHECK("outbound_deliveries"."automatic_attempt_count" >= 0),
	CONSTRAINT "ck_outbound_deliveries_max_attempts" CHECK("outbound_deliveries"."max_automatic_attempts" between 1 and 20),
	CONSTRAINT "ck_outbound_deliveries_attempt_budget" CHECK("outbound_deliveries"."automatic_attempt_count" <= "outbound_deliveries"."attempt_count"
        and "outbound_deliveries"."automatic_attempt_count" <= "outbound_deliveries"."max_automatic_attempts"),
	CONSTRAINT "ck_outbound_deliveries_target" CHECK("outbound_deliveries"."status" in ('blocked_configuration', 'payload_expired')
        or ("outbound_deliveries"."endpoint_id" is not null
          and "outbound_deliveries"."target_url" is not null
          and "outbound_deliveries"."signing_secret_ciphertext" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_outbound_deliveries_status_schedule` ON `outbound_deliveries` (`account_id`,`status`,`next_attempt_at`,`locked_until`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_outbound_deliveries_license` ON `outbound_deliveries` (`account_id`,`license_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_outbound_deliveries_customer` ON `outbound_deliveries` (`account_id`,`customer_id`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outbound_deliveries_account_id` ON `outbound_deliveries` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outbound_deliveries_customer_id` ON `outbound_deliveries` (`account_id`,`customer_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outbound_deliveries_license_id` ON `outbound_deliveries` (`account_id`,`license_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outbound_deliveries_idempotency` ON `outbound_deliveries` (`account_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `outbound_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`endpoint_type` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`signing_secret_ciphertext` text NOT NULL,
	`subscribed_events_json` text DEFAULT '[]' NOT NULL,
	`timeout_ms` integer DEFAULT 10000 NOT NULL,
	`max_automatic_attempts` integer DEFAULT 4 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_outbound_endpoints_type" CHECK("outbound_endpoints"."endpoint_type" in ('notification_gateway', 'event_subscriber')),
	CONSTRAINT "ck_outbound_endpoints_events_json" CHECK(json_valid("outbound_endpoints"."subscribed_events_json") and json_type("outbound_endpoints"."subscribed_events_json") = 'array'),
	CONSTRAINT "ck_outbound_endpoints_timeout" CHECK("outbound_endpoints"."timeout_ms" between 1000 and 30000),
	CONSTRAINT "ck_outbound_endpoints_attempts" CHECK("outbound_endpoints"."max_automatic_attempts" between 1 and 20),
	CONSTRAINT "ck_outbound_endpoints_status" CHECK("outbound_endpoints"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `idx_outbound_endpoints_account_type` ON `outbound_endpoints` (`account_id`,`endpoint_type`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outbound_active_notification_gateway` ON `outbound_endpoints` (`account_id`,`endpoint_type`) WHERE "outbound_endpoints"."endpoint_type" = 'notification_gateway' and "outbound_endpoints"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outbound_endpoints_account_id` ON `outbound_endpoints` (`account_id`,`id`);--> statement-breakpoint
CREATE TABLE `product_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`version` text NOT NULL,
	`platform` text NOT NULL,
	`description` text,
	`download_url` text,
	`artifact_sha256` text NOT NULL,
	`released_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`product_id`) REFERENCES `products`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_product_releases_artifact_sha256" CHECK(length("product_releases"."artifact_sha256") = 64
        and "product_releases"."artifact_sha256" = lower("product_releases"."artifact_sha256")
        and "product_releases"."artifact_sha256" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `idx_product_releases_lookup` ON `product_releases` (`account_id`,`product_id`,`version`,`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_product_releases_account_id` ON `product_releases` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_product_releases_identity` ON `product_releases` (`account_id`,`product_id`,`version`,`platform`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`billing_environment` text,
	`trial_enabled` integer DEFAULT 0 NOT NULL,
	`trial_duration_seconds` integer,
	`trial_features_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_products_billing_environment" CHECK("products"."billing_environment" in ('sandbox', 'live')),
	CONSTRAINT "ck_products_trial_enabled" CHECK("products"."trial_enabled" in (0, 1)),
	CONSTRAINT "ck_products_trial_duration_seconds" CHECK("products"."trial_duration_seconds" is null or "products"."trial_duration_seconds" > 0),
	CONSTRAINT "ck_products_trial_features_json" CHECK(json_valid("products"."trial_features_json") and json_type("products"."trial_features_json") = 'array'),
	CONSTRAINT "ck_products_status" CHECK("products"."status" in ('active', 'archived')),
	CONSTRAINT "ck_products_trial_configuration" CHECK("products"."trial_enabled" = 0 or "products"."trial_duration_seconds" is not null)
);
--> statement-breakpoint
CREATE INDEX `idx_products_account_status` ON `products` (`account_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_account_id` ON `products` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_account_slug` ON `products` (`account_id`,`slug`);--> statement-breakpoint
CREATE TABLE `signing_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`algorithm` text DEFAULT 'Ed25519' NOT NULL,
	`source` text NOT NULL,
	`public_key` text NOT NULL,
	`private_key_ciphertext` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`retired_at` text,
	`revoked_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`product_id`) REFERENCES `products`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_signing_keys_algorithm" CHECK("signing_keys"."algorithm" = 'Ed25519'),
	CONSTRAINT "ck_signing_keys_source" CHECK("signing_keys"."source" in ('generated', 'uploaded')),
	CONSTRAINT "ck_signing_keys_status" CHECK("signing_keys"."status" in ('active', 'retired', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_signing_keys_product_status` ON `signing_keys` (`account_id`,`product_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_signing_keys_product_active` ON `signing_keys` (`account_id`,`product_id`) WHERE "signing_keys"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `uq_signing_keys_account_id` ON `signing_keys` (`account_id`,`id`);--> statement-breakpoint
CREATE TABLE `system_issue_inbound_events` (
	`account_id` text NOT NULL,
	`system_issue_id` text NOT NULL,
	`inbound_event_id` text NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`system_issue_id`, `inbound_event_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`system_issue_id`) REFERENCES `system_issues`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`inbound_event_id`) REFERENCES `inbound_events`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_system_issue_inbound_events_occurrence_count" CHECK("system_issue_inbound_events"."occurrence_count" >= 1),
	CONSTRAINT "ck_system_issue_inbound_events_seen_order" CHECK("system_issue_inbound_events"."last_seen_at" >= "system_issue_inbound_events"."first_seen_at")
);
--> statement-breakpoint
CREATE INDEX `idx_system_issue_inbound_events_issue` ON `system_issue_inbound_events` (`account_id`,`system_issue_id`,"last_seen_at" desc);--> statement-breakpoint
CREATE INDEX `idx_system_issue_inbound_events_event` ON `system_issue_inbound_events` (`account_id`,`inbound_event_id`);--> statement-breakpoint
CREATE TABLE `system_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`billing_provider_id` text NOT NULL,
	`capability` text NOT NULL,
	`issue_code` text NOT NULL,
	`severity` text DEFAULT 'error' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_error_detail_json` text DEFAULT '{}' NOT NULL,
	`resolved_at` text,
	`resolved_by_user_id` text,
	`resolution_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`billing_provider_id`) REFERENCES `billing_providers`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`resolved_by_user_id`) REFERENCES `users`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_system_issues_capability" CHECK("system_issues"."capability" in ('customer_read', 'customer_portal_session')),
	CONSTRAINT "ck_system_issues_severity" CHECK("system_issues"."severity" in ('warning', 'error', 'critical')),
	CONSTRAINT "ck_system_issues_status" CHECK("system_issues"."status" in ('open', 'resolved')),
	CONSTRAINT "ck_system_issues_occurrence_count" CHECK("system_issues"."occurrence_count" >= 1),
	CONSTRAINT "ck_system_issues_seen_order" CHECK("system_issues"."last_seen_at" >= "system_issues"."first_seen_at"),
	CONSTRAINT "ck_system_issues_error_detail_json" CHECK(json_valid("system_issues"."last_error_detail_json") and json_type("system_issues"."last_error_detail_json") = 'object'),
	CONSTRAINT "ck_system_issues_resolution" CHECK(("system_issues"."status" = 'open'
          and "system_issues"."resolved_at" is null
          and "system_issues"."resolved_by_user_id" is null
          and "system_issues"."resolution_note" is null)
        or ("system_issues"."status" = 'resolved'
          and "system_issues"."resolved_at" is not null
          and "system_issues"."resolved_by_user_id" is not null
          and "system_issues"."resolution_note" is not null
          and length(trim("system_issues"."resolution_note")) > 0))
);
--> statement-breakpoint
CREATE INDEX `idx_system_issues_status` ON `system_issues` (`account_id`,`status`,`severity`,"last_seen_at" desc);--> statement-breakpoint
CREATE INDEX `idx_system_issues_provider_capability` ON `system_issues` (`account_id`,`billing_provider_id`,`capability`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_system_issues_account_id` ON `system_issues` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_system_issues_identity` ON `system_issues` (`account_id`,`billing_provider_id`,`capability`,`issue_code`);--> statement-breakpoint
CREATE TABLE `system_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_name` text NOT NULL,
	`app_url` text NOT NULL,
	`site_url` text NOT NULL,
	`api_base_url` text,
	`scheduler_last_success_at` text,
	`scheduler_last_duration_ms` integer,
	`initialized_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ck_system_settings_singleton" CHECK("system_settings"."id" = 'current'),
	CONSTRAINT "ck_system_settings_scheduler_duration" CHECK("system_settings"."scheduler_last_duration_ms" is null or "system_settings"."scheduler_last_duration_ms" >= 0),
	CONSTRAINT "ck_system_settings_scheduler_health_pair" CHECK(("system_settings"."scheduler_last_success_at" is null and "system_settings"."scheduler_last_duration_ms" is null)
        or ("system_settings"."scheduler_last_success_at" is not null and "system_settings"."scheduler_last_duration_ms" is not null))
);
--> statement-breakpoint
CREATE TABLE `trial_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product_id` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`trial_token_hash` text NOT NULL,
	`features_json` text DEFAULT '[]' NOT NULL,
	`claimed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_validated_at` text,
	`revoked_at` text,
	`revoke_reason` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`,`product_id`) REFERENCES `products`(`account_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_trial_claims_features_json" CHECK(json_valid("trial_claims"."features_json") and json_type("trial_claims"."features_json") = 'array'),
	CONSTRAINT "ck_trial_claims_expiry" CHECK("trial_claims"."expires_at" > "trial_claims"."claimed_at"),
	CONSTRAINT "ck_trial_claims_revocation" CHECK(("trial_claims"."revoked_at" is null and "trial_claims"."revoke_reason" is null)
        or ("trial_claims"."revoked_at" is not null and "trial_claims"."revoke_reason" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_trial_claims_lookup` ON `trial_claims` (`account_id`,`product_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_trial_claims_expiry` ON `trial_claims` (`account_id`,`product_id`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_trial_claims_account_id` ON `trial_claims` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_trial_claims_token_hash` ON `trial_claims` (`account_id`,`trial_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_trial_claims_device` ON `trial_claims` (`account_id`,`product_id`,`fingerprint_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`password_hash` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_users_role" CHECK("users"."role" in ('owner', 'admin', 'member', 'viewer')),
	CONSTRAINT "ck_users_status" CHECK("users"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `idx_users_account_status` ON `users` (`account_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_account_id` ON `users` (`account_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_account_email` ON `users` (`account_id`,`email`);
--> statement-breakpoint
CREATE TRIGGER trg_system_settings_prevent_delete
BEFORE DELETE ON system_settings
BEGIN
    SELECT RAISE(ABORT, 'SYSTEM_SETUP_STATE_DELETE_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER trg_product_releases_immutable_identity
BEFORE UPDATE OF id, account_id, product_id, version, platform, artifact_sha256, released_at
ON product_releases
WHEN NEW.id IS NOT OLD.id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.version IS NOT OLD.version
  OR NEW.platform IS NOT OLD.platform
  OR NEW.artifact_sha256 IS NOT OLD.artifact_sha256
  OR NEW.released_at IS NOT OLD.released_at
BEGIN
    SELECT RAISE(ABORT, 'PRODUCT_RELEASE_IDENTITY_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER trg_product_releases_prevent_delete
BEFORE DELETE ON product_releases
BEGIN
    SELECT RAISE(ABORT, 'PRODUCT_RELEASE_DELETE_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER trg_activations_enforce_limit_on_insert
BEFORE INSERT ON activations
WHEN NEW.status = 'active'
BEGIN
    SELECT CASE
        WHEN (
            SELECT COUNT(*)
            FROM activations
            WHERE account_id = NEW.account_id
              AND license_id = NEW.license_id
              AND status = 'active'
        ) >= (
            SELECT max_activations
            FROM licenses
            WHERE account_id = NEW.account_id
              AND id = NEW.license_id
        )
        THEN RAISE(ABORT, 'LICENSE_ACTIVATION_LIMIT_REACHED')
    END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_activations_enforce_limit_on_reactivate
BEFORE UPDATE OF status ON activations
WHEN OLD.status <> 'active' AND NEW.status = 'active'
BEGIN
    SELECT CASE
        WHEN (
            SELECT COUNT(*)
            FROM activations
            WHERE account_id = NEW.account_id
              AND license_id = NEW.license_id
              AND status = 'active'
        ) >= (
            SELECT max_activations
            FROM licenses
            WHERE account_id = NEW.account_id
              AND id = NEW.license_id
        )
        THEN RAISE(ABORT, 'LICENSE_ACTIVATION_LIMIT_REACHED')
    END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_billing_providers_immutable_identity
BEFORE UPDATE OF account_id, provider, environment ON billing_providers
WHEN NEW.account_id IS NOT OLD.account_id
  OR NEW.provider IS NOT OLD.provider
  OR NEW.environment IS NOT OLD.environment
BEGIN
    SELECT RAISE(ABORT, 'billing_provider_identity_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER trg_products_guard_billing_environment_change
BEFORE UPDATE OF billing_environment ON products
WHEN NEW.billing_environment IS NOT OLD.billing_environment
BEGIN
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM billing_offers AS offer
            WHERE offer.account_id = OLD.account_id
              AND offer.product_id = OLD.id
              AND offer.status = 'active'
        )
        OR EXISTS (
            SELECT 1
            FROM licenses AS license
            WHERE license.account_id = OLD.account_id
              AND license.product_id = OLD.id
              AND license.source = 'payment'
              AND license.is_checkout_verification = 0
        )
        THEN RAISE(ABORT, 'product_billing_environment_locked')
    END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_billing_offers_active_environment_on_insert
BEFORE INSERT ON billing_offers
WHEN NEW.status = 'active'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM products AS product
        JOIN billing_providers AS provider
          ON provider.account_id = NEW.account_id
         AND provider.id = NEW.billing_provider_id
        WHERE product.account_id = NEW.account_id
          AND product.id = NEW.product_id
          AND product.billing_environment IS NOT NULL
          AND product.billing_environment = provider.environment
    ) THEN RAISE(ABORT, 'billing_offer_environment_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_billing_offers_active_environment_on_update
BEFORE UPDATE OF status, billing_provider_id, product_id, account_id ON billing_offers
WHEN NEW.status = 'active'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM products AS product
        JOIN billing_providers AS provider
          ON provider.account_id = NEW.account_id
         AND provider.id = NEW.billing_provider_id
        WHERE product.account_id = NEW.account_id
          AND product.id = NEW.product_id
          AND product.billing_environment IS NOT NULL
          AND product.billing_environment = provider.environment
    ) THEN RAISE(ABORT, 'billing_offer_environment_mismatch') END;
END;
--> statement-breakpoint
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
END;
--> statement-breakpoint
CREATE TRIGGER trg_licenses_payment_environment_on_insert
BEFORE INSERT ON licenses
WHEN NEW.source = 'payment' AND NEW.is_checkout_verification = 0
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM products AS product
        JOIN billing_providers AS provider
          ON provider.account_id = NEW.account_id
         AND provider.id = NEW.source_billing_provider_id
        WHERE product.account_id = NEW.account_id
          AND product.id = NEW.product_id
          AND product.billing_environment IS NOT NULL
          AND product.billing_environment = provider.environment
    ) THEN RAISE(ABORT, 'payment_license_environment_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_licenses_verification_environment_on_insert
BEFORE INSERT ON licenses
WHEN NEW.is_checkout_verification = 1
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM billing_providers AS provider
        WHERE provider.account_id = NEW.account_id
          AND provider.id = NEW.source_billing_provider_id
          AND provider.environment = 'sandbox'
    ) THEN RAISE(ABORT, 'checkout_verification_requires_sandbox') END;
END;
--> statement-breakpoint
CREATE TRIGGER trg_licenses_verification_flag_immutable
BEFORE UPDATE OF is_checkout_verification ON licenses
WHEN NEW.is_checkout_verification IS NOT OLD.is_checkout_verification
BEGIN
    SELECT RAISE(ABORT, 'checkout_verification_flag_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER trg_checkout_verifications_require_draft_sandbox
BEFORE INSERT ON billing_checkout_verifications
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM billing_offers AS offer
        JOIN billing_providers AS provider
          ON provider.account_id = NEW.account_id
         AND provider.id = offer.billing_provider_id
        WHERE offer.account_id = NEW.account_id
          AND offer.id = NEW.billing_offer_id
          AND offer.status = 'draft'
          AND provider.environment = 'sandbox'
    ) THEN RAISE(ABORT, 'checkout_verification_requires_draft_sandbox_offer') END;
END;
--> statement-breakpoint
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
END;
