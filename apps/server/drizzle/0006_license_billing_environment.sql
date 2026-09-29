PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
ALTER TABLE licenses ADD COLUMN billing_environment text NOT NULL DEFAULT 'live'
  CONSTRAINT ck_licenses_billing_environment CHECK (billing_environment IN ('sandbox', 'live'));--> statement-breakpoint
UPDATE licenses
SET billing_environment = (
  SELECT provider.environment FROM billing_providers AS provider
  WHERE provider.instance_id = licenses.instance_id
    AND provider.id = licenses.source_billing_provider_id
)
WHERE source = 'payment';--> statement-breakpoint
UPDATE licenses
SET billing_environment = COALESCE((
  SELECT product.billing_environment FROM products AS product
  WHERE product.instance_id = licenses.instance_id
    AND product.id = licenses.product_id
), 'live')
WHERE source IN ('manual', 'api');--> statement-breakpoint
DROP TRIGGER trg_products_guard_billing_environment_change;--> statement-breakpoint
DROP TRIGGER trg_billing_offers_active_environment_on_insert;--> statement-breakpoint
DROP TRIGGER trg_billing_offers_active_environment_on_update;--> statement-breakpoint
DROP TRIGGER trg_licenses_payment_environment_on_insert;--> statement-breakpoint
DROP TRIGGER trg_licenses_manual_issue_invariant;--> statement-breakpoint
DROP TRIGGER trg_license_plans_payment_grace_snapshot;--> statement-breakpoint
CREATE TABLE `__new_products` (
  `id` text PRIMARY KEY NOT NULL,
  `instance_id` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `payment_grace_seconds` integer DEFAULT 0 NOT NULL,
  `validation_interval_seconds` integer DEFAULT 3600 NOT NULL,
  `trial_enabled` integer DEFAULT false NOT NULL,
  `trial_duration_seconds` integer,
  `trial_features_json` text DEFAULT '[]' NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT "ck_products_payment_grace" CHECK("__new_products"."payment_grace_seconds" >= 0),
  CONSTRAINT "ck_products_validation_interval" CHECK("__new_products"."validation_interval_seconds" between 3600 and 86400),
  CONSTRAINT "ck_products_trial_enabled" CHECK("__new_products"."trial_enabled" in (0, 1)),
  CONSTRAINT "ck_products_trial_duration_seconds" CHECK("__new_products"."trial_duration_seconds" is null or "__new_products"."trial_duration_seconds" > 0),
  CONSTRAINT "ck_products_trial_features_json" CHECK(json_valid("__new_products"."trial_features_json") and json_type("__new_products"."trial_features_json") = 'array'),
  CONSTRAINT "ck_products_status" CHECK("__new_products"."status" in ('active', 'archived')),
  CONSTRAINT "ck_products_trial_configuration" CHECK("__new_products"."trial_enabled" = 0 or "__new_products"."trial_duration_seconds" is not null)
);--> statement-breakpoint
INSERT INTO `__new_products`
  (`id`, `instance_id`, `name`, `description`, `payment_grace_seconds`,
   `validation_interval_seconds`, `trial_enabled`, `trial_duration_seconds`,
   `trial_features_json`, `status`, `created_at`, `updated_at`)
SELECT `id`, `instance_id`, `name`, `description`, `payment_grace_seconds`,
       `validation_interval_seconds`, `trial_enabled`, `trial_duration_seconds`,
       `trial_features_json`, `status`, `created_at`, `updated_at`
FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
CREATE INDEX `idx_products_instance_status` ON `products` (`instance_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_instance_id` ON `products` (`instance_id`,`id`);--> statement-breakpoint
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
CREATE TRIGGER trg_licenses_payment_environment_on_insert
BEFORE INSERT ON licenses
WHEN NEW.source = 'payment'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM billing_providers AS provider
    WHERE provider.instance_id = NEW.instance_id
      AND provider.id = NEW.source_billing_provider_id
      AND provider.environment = NEW.billing_environment
  ) THEN RAISE(ABORT, 'payment_license_environment_mismatch') END);
END;--> statement-breakpoint
CREATE TRIGGER trg_licenses_billing_environment_immutable
BEFORE UPDATE OF billing_environment ON licenses
WHEN NEW.billing_environment IS NOT OLD.billing_environment
BEGIN
  SELECT RAISE(ABORT, 'license_billing_environment_immutable');
END;--> statement-breakpoint
CREATE TRIGGER trg_licenses_payment_provider_environment_on_update
BEFORE UPDATE OF source, source_billing_provider_id ON licenses
WHEN NEW.source = 'payment'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM billing_providers AS provider
    WHERE provider.instance_id = NEW.instance_id
      AND provider.id = NEW.source_billing_provider_id
      AND provider.environment = NEW.billing_environment
  ) THEN RAISE(ABORT, 'payment_license_environment_mismatch') END);
END;--> statement-breakpoint
CREATE TABLE `__migration_fk_guard` (
  `ok` integer NOT NULL CONSTRAINT `ck_migration_fk_guard` CHECK (`ok` = 1)
);--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`ok`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;--> statement-breakpoint
DROP TABLE `__migration_fk_guard`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
