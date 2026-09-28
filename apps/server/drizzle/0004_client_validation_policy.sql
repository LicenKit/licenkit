PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
DROP TRIGGER `trg_activations_enforce_limit_on_insert`;--> statement-breakpoint
DROP TRIGGER `trg_activations_enforce_limit_on_reactivate`;--> statement-breakpoint
DROP TRIGGER `trg_products_guard_billing_environment_change`;--> statement-breakpoint
DROP TRIGGER `trg_billing_offers_active_environment_on_insert`;--> statement-breakpoint
DROP TRIGGER `trg_billing_offers_active_environment_on_update`;--> statement-breakpoint
DROP TRIGGER `trg_licenses_payment_environment_on_insert`;--> statement-breakpoint
DROP TRIGGER `trg_licenses_verification_environment_on_insert`;--> statement-breakpoint
DROP TRIGGER `trg_licenses_verification_flag_immutable`;--> statement-breakpoint
DROP TRIGGER `trg_licenses_manual_issue_invariant`;--> statement-breakpoint
DROP TRIGGER `trg_license_plans_payment_grace_snapshot`;--> statement-breakpoint
DROP TRIGGER `trg_licenses_payment_grace_snapshot`;--> statement-breakpoint
CREATE TABLE `__new_license_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`license_model` text NOT NULL,
	`credential_mode` text NOT NULL,
	`default_term_seconds` integer,
	`update_window_seconds` integer,
	`offline_grace_seconds` integer DEFAULT 2592000 NOT NULL,
	`payment_grace_seconds` integer NOT NULL,
	`max_activations` integer DEFAULT 1 NOT NULL,
	`features_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`instance_id`,`product_id`) REFERENCES `products`(`instance_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_license_plans_revision" CHECK("__new_license_plans"."revision" >= 1),
	CONSTRAINT "ck_license_plans_license_model" CHECK("__new_license_plans"."license_model" in ('perpetual', 'fixed_term', 'subscription')),
	CONSTRAINT "ck_license_plans_credential_mode" CHECK("__new_license_plans"."credential_mode" in ('opaque', 'signed')),
	CONSTRAINT "ck_license_plans_default_term_seconds" CHECK("__new_license_plans"."default_term_seconds" is null or "__new_license_plans"."default_term_seconds" > 0),
	CONSTRAINT "ck_license_plans_update_window_seconds" CHECK("__new_license_plans"."update_window_seconds" is null or "__new_license_plans"."update_window_seconds" > 0),
	CONSTRAINT "ck_license_plans_offline_grace" CHECK("__new_license_plans"."offline_grace_seconds" > 0),
	CONSTRAINT "ck_license_plans_payment_grace" CHECK("__new_license_plans"."payment_grace_seconds" >= 0),
	CONSTRAINT "ck_license_plans_max_activations" CHECK("__new_license_plans"."max_activations" >= 1),
	CONSTRAINT "ck_license_plans_features_json" CHECK(json_valid("__new_license_plans"."features_json") and json_type("__new_license_plans"."features_json") = 'array'),
	CONSTRAINT "ck_license_plans_status" CHECK("__new_license_plans"."status" in ('active', 'archived')),
	CONSTRAINT "ck_license_plans_term_model" CHECK(("__new_license_plans"."license_model" = 'fixed_term' and "__new_license_plans"."default_term_seconds" is not null)
        or ("__new_license_plans"."license_model" in ('perpetual', 'subscription') and "__new_license_plans"."default_term_seconds" is null)),
	CONSTRAINT "ck_license_plans_update_model" CHECK("__new_license_plans"."license_model" = 'perpetual' or "__new_license_plans"."update_window_seconds" is null),
	CONSTRAINT "ck_license_plans_payment_grace_model" CHECK(("__new_license_plans"."license_model" = 'subscription' and "__new_license_plans"."payment_grace_seconds" >= 0)
        or ("__new_license_plans"."license_model" in ('perpetual', 'fixed_term') and "__new_license_plans"."payment_grace_seconds" = 0))
);
--> statement-breakpoint
INSERT INTO `__new_license_plans`("id", "instance_id", "product_id", "name", "revision", "license_model", "credential_mode", "default_term_seconds", "update_window_seconds", "offline_grace_seconds", "payment_grace_seconds", "max_activations", "features_json", "status", "created_at", "updated_at") SELECT "id", "instance_id", "product_id", "name", "revision", "license_model", "credential_mode", "default_term_seconds", "update_window_seconds", CASE WHEN "signed_token_ttl_seconds" > 0 THEN "signed_token_ttl_seconds" ELSE 2592000 END, "payment_grace_seconds", "max_activations", "features_json", "status", "created_at", "updated_at" FROM `license_plans`;--> statement-breakpoint
DROP TABLE `license_plans`;--> statement-breakpoint
ALTER TABLE `__new_license_plans` RENAME TO `license_plans`;--> statement-breakpoint
CREATE INDEX `idx_license_plans_product_status` ON `license_plans` (`instance_id`,`product_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_license_plans_instance_id` ON `license_plans` (`instance_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_license_plans_product_id` ON `license_plans` (`instance_id`,`product_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_licenses` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`product_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`license_model` text NOT NULL,
	`renewal_mode` text NOT NULL,
	`credential_mode` text NOT NULL,
	`offline_grace_seconds` integer DEFAULT 2592000 NOT NULL,
	`payment_grace_seconds` integer NOT NULL,
	`max_activations` integer NOT NULL,
	`features_json` text DEFAULT '[]' NOT NULL,
	`key_hash` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`key_rotated_at` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_billing_provider_id` text,
	`source_external_transaction_id` text,
	`is_checkout_verification` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`status_reason` text,
	`expires_at` text,
	`updates_until` text,
	`suspended_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`instance_id`,`customer_id`) REFERENCES `customers`(`instance_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`instance_id`,`product_id`) REFERENCES `products`(`instance_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`instance_id`,`product_id`,`plan_id`) REFERENCES `license_plans`(`instance_id`,`product_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`instance_id`,`source_billing_provider_id`) REFERENCES `billing_providers`(`instance_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_licenses_plan_revision" CHECK("__new_licenses"."plan_revision" >= 1),
	CONSTRAINT "ck_licenses_license_model" CHECK("__new_licenses"."license_model" in ('perpetual', 'fixed_term', 'subscription')),
	CONSTRAINT "ck_licenses_renewal_mode" CHECK("__new_licenses"."renewal_mode" in ('none', 'manual', 'billing')),
	CONSTRAINT "ck_licenses_credential_mode" CHECK("__new_licenses"."credential_mode" in ('opaque', 'signed')),
	CONSTRAINT "ck_licenses_offline_grace" CHECK("__new_licenses"."offline_grace_seconds" > 0),
	CONSTRAINT "ck_licenses_payment_grace" CHECK("__new_licenses"."payment_grace_seconds" >= 0),
	CONSTRAINT "ck_licenses_max_activations" CHECK("__new_licenses"."max_activations" >= 1),
	CONSTRAINT "ck_licenses_features_json" CHECK(json_valid("__new_licenses"."features_json") and json_type("__new_licenses"."features_json") = 'array'),
	CONSTRAINT "ck_licenses_key_version" CHECK("__new_licenses"."key_version" >= 1),
	CONSTRAINT "ck_licenses_source" CHECK("__new_licenses"."source" in ('manual', 'api', 'payment')),
	CONSTRAINT "ck_licenses_verification" CHECK("__new_licenses"."is_checkout_verification" in (0, 1)),
	CONSTRAINT "ck_licenses_status" CHECK("__new_licenses"."status" in ('active', 'suspended', 'revoked')),
	CONSTRAINT "ck_licenses_expiry_model" CHECK(("__new_licenses"."license_model" = 'perpetual' and "__new_licenses"."expires_at" is null)
        or ("__new_licenses"."license_model" in ('fixed_term', 'subscription') and "__new_licenses"."expires_at" is not null)),
	CONSTRAINT "ck_licenses_update_model" CHECK("__new_licenses"."license_model" = 'perpetual' or "__new_licenses"."updates_until" is null),
	CONSTRAINT "ck_licenses_payment_grace_model" CHECK(("__new_licenses"."license_model" = 'subscription' and "__new_licenses"."payment_grace_seconds" >= 0)
        or ("__new_licenses"."license_model" in ('perpetual', 'fixed_term') and "__new_licenses"."payment_grace_seconds" = 0)),
	CONSTRAINT "ck_licenses_source_reference" CHECK(("__new_licenses"."source" = 'payment'
          and "__new_licenses"."source_billing_provider_id" is not null
          and "__new_licenses"."source_external_transaction_id" is not null)
        or ("__new_licenses"."source" in ('manual', 'api')
          and "__new_licenses"."source_billing_provider_id" is null
          and "__new_licenses"."source_external_transaction_id" is null)),
	CONSTRAINT "ck_licenses_checkout_verification" CHECK("__new_licenses"."is_checkout_verification" = 0
        or ("__new_licenses"."source" = 'payment'
          and "__new_licenses"."status" = 'suspended'
          and "__new_licenses"."status_reason" = 'checkout_verification')),
	CONSTRAINT "ck_licenses_renewal_authority" CHECK(("__new_licenses"."license_model" in ('perpetual', 'fixed_term') and "__new_licenses"."renewal_mode" = 'none')
        or ("__new_licenses"."license_model" = 'subscription'
          and "__new_licenses"."renewal_mode" = 'manual'
          and "__new_licenses"."source" in ('manual', 'api'))
        or ("__new_licenses"."license_model" = 'subscription'
          and "__new_licenses"."renewal_mode" = 'billing'
          and "__new_licenses"."source" = 'payment')),
	CONSTRAINT "ck_licenses_manual_expiry" CHECK("__new_licenses"."renewal_mode" <> 'manual' or "__new_licenses"."expires_at" > "__new_licenses"."created_at"),
	CONSTRAINT "ck_licenses_billing_grace" CHECK("__new_licenses"."renewal_mode" = 'billing' or "__new_licenses"."payment_grace_seconds" = 0)
);
--> statement-breakpoint
INSERT INTO `__new_licenses`("id", "instance_id", "customer_id", "product_id", "plan_id", "plan_revision", "license_model", "renewal_mode", "credential_mode", "offline_grace_seconds", "payment_grace_seconds", "max_activations", "features_json", "key_hash", "key_version", "key_rotated_at", "source", "source_billing_provider_id", "source_external_transaction_id", "is_checkout_verification", "status", "status_reason", "expires_at", "updates_until", "suspended_at", "revoked_at", "created_at", "updated_at") SELECT "id", "instance_id", "customer_id", "product_id", "plan_id", "plan_revision", "license_model", "renewal_mode", "credential_mode", CASE WHEN "signed_token_ttl_seconds" > 0 THEN "signed_token_ttl_seconds" ELSE 2592000 END, "payment_grace_seconds", "max_activations", "features_json", "key_hash", "key_version", "key_rotated_at", "source", "source_billing_provider_id", "source_external_transaction_id", "is_checkout_verification", "status", "status_reason", "expires_at", "updates_until", "suspended_at", "revoked_at", "created_at", "updated_at" FROM `licenses`;--> statement-breakpoint
DROP TABLE `licenses`;--> statement-breakpoint
ALTER TABLE `__new_licenses` RENAME TO `licenses`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_licenses_source_transaction` ON `licenses` (`instance_id`,`source_billing_provider_id`,`source_external_transaction_id`) WHERE "licenses"."source_billing_provider_id" is not null and "licenses"."source_external_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_licenses_instance_status` ON `licenses` (`instance_id`,`status`,`created_at` DESC);--> statement-breakpoint
CREATE INDEX `idx_licenses_product_plan` ON `licenses` (`instance_id`,`product_id`,`plan_id`);--> statement-breakpoint
CREATE INDEX `idx_licenses_customer` ON `licenses` (`instance_id`,`customer_id`,`created_at` DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_licenses_instance_id` ON `licenses` (`instance_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_licenses_instance_key_hash` ON `licenses` (`instance_id`,`key_hash`);--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`billing_environment` text,
	`payment_grace_seconds` integer DEFAULT 0 NOT NULL,
	`validation_interval_seconds` integer DEFAULT 3600 NOT NULL,
	`trial_enabled` integer DEFAULT false NOT NULL,
	`trial_duration_seconds` integer,
	`trial_features_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_products_billing_environment" CHECK("__new_products"."billing_environment" in ('sandbox', 'live')),
	CONSTRAINT "ck_products_payment_grace" CHECK("__new_products"."payment_grace_seconds" >= 0),
	CONSTRAINT "ck_products_validation_interval" CHECK("__new_products"."validation_interval_seconds" between 3600 and 86400),
	CONSTRAINT "ck_products_trial_enabled" CHECK("__new_products"."trial_enabled" in (0, 1)),
	CONSTRAINT "ck_products_trial_duration_seconds" CHECK("__new_products"."trial_duration_seconds" is null or "__new_products"."trial_duration_seconds" > 0),
	CONSTRAINT "ck_products_trial_features_json" CHECK(json_valid("__new_products"."trial_features_json") and json_type("__new_products"."trial_features_json") = 'array'),
	CONSTRAINT "ck_products_status" CHECK("__new_products"."status" in ('active', 'archived')),
	CONSTRAINT "ck_products_trial_configuration" CHECK("__new_products"."trial_enabled" = 0 or "__new_products"."trial_duration_seconds" is not null)
);
--> statement-breakpoint
INSERT INTO `__new_products`("id", "instance_id", "name", "description", "billing_environment", "payment_grace_seconds", "validation_interval_seconds", "trial_enabled", "trial_duration_seconds", "trial_features_json", "status", "created_at", "updated_at") SELECT "id", "instance_id", "name", "description", "billing_environment", "payment_grace_seconds", 3600, "trial_enabled", "trial_duration_seconds", "trial_features_json", "status", "created_at", "updated_at" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
CREATE INDEX `idx_products_instance_status` ON `products` (`instance_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_instance_id` ON `products` (`instance_id`,`id`);--> statement-breakpoint
CREATE TRIGGER trg_activations_enforce_limit_on_insert
BEFORE INSERT ON activations
WHEN NEW.status = 'active'
BEGIN
  SELECT (CASE
    WHEN (
      SELECT COUNT(*) FROM activations
      WHERE instance_id = NEW.instance_id
        AND license_id = NEW.license_id
        AND status = 'active'
    ) >= (
      SELECT max_activations FROM licenses
      WHERE instance_id = NEW.instance_id AND id = NEW.license_id
    ) THEN RAISE(ABORT, 'LICENSE_ACTIVATION_LIMIT_REACHED')
  END);
END;--> statement-breakpoint
CREATE TRIGGER trg_activations_enforce_limit_on_reactivate
BEFORE UPDATE OF status ON activations
WHEN OLD.status <> 'active' AND NEW.status = 'active'
BEGIN
  SELECT (CASE
    WHEN (
      SELECT COUNT(*) FROM activations
      WHERE instance_id = NEW.instance_id
        AND license_id = NEW.license_id
        AND status = 'active'
    ) >= (
      SELECT max_activations FROM licenses
      WHERE instance_id = NEW.instance_id AND id = NEW.license_id
    ) THEN RAISE(ABORT, 'LICENSE_ACTIVATION_LIMIT_REACHED')
  END);
END;--> statement-breakpoint
CREATE TRIGGER trg_products_guard_billing_environment_change
BEFORE UPDATE OF billing_environment ON products
WHEN NEW.billing_environment IS NOT OLD.billing_environment
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM billing_offers AS offer
    WHERE offer.instance_id = OLD.instance_id
      AND offer.product_id = OLD.id
      AND offer.status = 'active'
  ) OR EXISTS (
    SELECT 1 FROM licenses AS license
    WHERE license.instance_id = OLD.instance_id
      AND license.product_id = OLD.id
      AND license.source = 'payment'
      AND license.is_checkout_verification = 0
  ) THEN RAISE(ABORT, 'product_billing_environment_locked') END);
END;--> statement-breakpoint
CREATE TRIGGER trg_billing_offers_active_environment_on_insert
BEFORE INSERT ON billing_offers
WHEN NEW.status = 'active'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM products AS product
    JOIN billing_providers AS provider
      ON provider.instance_id = NEW.instance_id
     AND provider.id = NEW.billing_provider_id
    WHERE product.instance_id = NEW.instance_id
      AND product.id = NEW.product_id
      AND product.billing_environment IS NOT NULL
      AND product.billing_environment = provider.environment
  ) THEN RAISE(ABORT, 'billing_offer_environment_mismatch') END);
END;--> statement-breakpoint
CREATE TRIGGER trg_billing_offers_active_environment_on_update
BEFORE UPDATE OF status, billing_provider_id, product_id, instance_id ON billing_offers
WHEN NEW.status = 'active'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM products AS product
    JOIN billing_providers AS provider
      ON provider.instance_id = NEW.instance_id
     AND provider.id = NEW.billing_provider_id
    WHERE product.instance_id = NEW.instance_id
      AND product.id = NEW.product_id
      AND product.billing_environment IS NOT NULL
      AND product.billing_environment = provider.environment
  ) THEN RAISE(ABORT, 'billing_offer_environment_mismatch') END);
END;--> statement-breakpoint
CREATE TRIGGER trg_licenses_payment_environment_on_insert
BEFORE INSERT ON licenses
WHEN NEW.source = 'payment' AND NEW.is_checkout_verification = 0
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM products AS product
    JOIN billing_providers AS provider
      ON provider.instance_id = NEW.instance_id
     AND provider.id = NEW.source_billing_provider_id
    WHERE product.instance_id = NEW.instance_id
      AND product.id = NEW.product_id
      AND product.billing_environment IS NOT NULL
      AND product.billing_environment = provider.environment
  ) THEN RAISE(ABORT, 'payment_license_environment_mismatch') END);
END;--> statement-breakpoint
CREATE TRIGGER trg_licenses_verification_environment_on_insert
BEFORE INSERT ON licenses
WHEN NEW.is_checkout_verification = 1
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM billing_providers AS provider
    WHERE provider.instance_id = NEW.instance_id
      AND provider.id = NEW.source_billing_provider_id
      AND provider.environment = 'sandbox'
  ) THEN RAISE(ABORT, 'checkout_verification_requires_sandbox') END);
END;--> statement-breakpoint
CREATE TRIGGER trg_licenses_verification_flag_immutable
BEFORE UPDATE OF is_checkout_verification ON licenses
WHEN NEW.is_checkout_verification IS NOT OLD.is_checkout_verification
BEGIN
  SELECT RAISE(ABORT, 'checkout_verification_flag_immutable');
END;--> statement-breakpoint
CREATE TRIGGER trg_licenses_manual_issue_invariant
BEFORE INSERT ON licenses
WHEN NEW.source = 'manual' AND NOT EXISTS (
  SELECT 1 FROM license_plans AS plan
  JOIN products AS product
    ON product.instance_id = plan.instance_id
   AND product.id = plan.product_id
  JOIN customers AS customer
    ON customer.instance_id = plan.instance_id
   AND customer.id = NEW.customer_id
  WHERE plan.instance_id = NEW.instance_id
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
        WHERE signing_key.instance_id = NEW.instance_id
          AND signing_key.product_id = NEW.product_id
          AND signing_key.status = 'active'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'LICENSE_MANUAL_ISSUE_INVARIANT');
END;--> statement-breakpoint
CREATE TRIGGER trg_license_plans_payment_grace_snapshot
BEFORE INSERT ON license_plans
WHEN NEW.license_model = 'subscription'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM products
    WHERE instance_id = NEW.instance_id
      AND id = NEW.product_id
      AND payment_grace_seconds = NEW.payment_grace_seconds
  ) THEN RAISE(ABORT, 'LICENSE_PLAN_PAYMENT_GRACE_MISMATCH') END);
END;--> statement-breakpoint
CREATE TRIGGER trg_licenses_payment_grace_snapshot
BEFORE INSERT ON licenses
WHEN NEW.renewal_mode = 'billing'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM license_plans
    WHERE instance_id = NEW.instance_id
      AND product_id = NEW.product_id
      AND id = NEW.plan_id
      AND payment_grace_seconds = NEW.payment_grace_seconds
  ) THEN RAISE(ABORT, 'LICENSE_PAYMENT_GRACE_MISMATCH') END);
END;--> statement-breakpoint
-- Verify all references before ending deferral after the table rebuilds.
CREATE TABLE `__migration_fk_guard` (
	`ok` integer NOT NULL CONSTRAINT `ck_migration_fk_guard` CHECK (`ok` = 1)
);--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;--> statement-breakpoint
DROP TABLE `__migration_fk_guard`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
