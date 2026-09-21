import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { SQLiteTableExtraConfigValue } from "drizzle-orm/sqlite-core";

const restrictReference = { onDelete: "restrict" as const };
const nocaseText = customType<{ data: string }>({
  dataType() {
    return "text COLLATE NOCASE";
  },
});

export const instances = sqliteTable(
  "instances",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    siteUrl: text("site_url").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_instances_slug").on(table.slug),
    check(
      "ck_instances_slug",
      sql`length(${table.slug}) > 0
        and ${table.slug} = lower(${table.slug})
        and ${table.slug} not glob '*[^a-z0-9-]*'
        and ${table.slug} not like '-%'
        and ${table.slug} not like '%-'`,
    ),
    check("ck_instances_status", sql`${table.status} in ('active', 'suspended', 'archived')`),
  ],
);

export const deploymentBootstrap = sqliteTable(
  "deployment_bootstrap",
  {
    singletonKey: text("singleton_key").primaryKey(),
    completedAt: text("completed_at").notNull(),
  },
  (table) => [
    check("ck_deployment_bootstrap_singleton", sql`${table.singletonKey} = 'deployment'`),
  ],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: nocaseText("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_users_email").on(table.email),
  ],
);

export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, restrictReference),
    sessionTokenHash: text("session_token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    unique("uq_admin_sessions_token_hash").on(table.sessionTokenHash),
    unique("uq_admin_sessions_csrf_token_hash").on(table.csrfTokenHash),
    index("idx_admin_sessions_user_expiry").on(table.userId, table.expiresAt),
    index("idx_admin_sessions_lookup").on(table.sessionTokenHash),
  ],
);

export const customers = sqliteTable(
  "customers",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    email: nocaseText("email").notNull(),
    name: text("name"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_customers_instance_id").on(table.instanceId, table.id),
    unique("uq_customers_instance_email").on(table.instanceId, table.email),
    index("idx_customers_instance_status").on(
      table.instanceId,
      table.status,
      sql`${table.createdAt} desc`,
    ),
    check("ck_customers_status", sql`${table.status} in ('active', 'disabled')`),
  ],
);

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    billingEnvironment: text("billing_environment"),
    paymentGraceSeconds: integer("payment_grace_seconds").notNull().default(0),
    trialEnabled: integer("trial_enabled", { mode: "boolean" }).notNull().default(false),
    trialDurationSeconds: integer("trial_duration_seconds"),
    trialFeaturesJson: text("trial_features_json").notNull().default("[]"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_products_instance_id").on(table.instanceId, table.id),
    unique("uq_products_instance_slug").on(table.instanceId, table.slug),
    index("idx_products_instance_status").on(table.instanceId, table.status),
    check(
      "ck_products_billing_environment",
      sql`${table.billingEnvironment} in ('sandbox', 'live')`,
    ),
    check("ck_products_payment_grace", sql`${table.paymentGraceSeconds} >= 0`),
    check("ck_products_trial_enabled", sql`${table.trialEnabled} in (0, 1)`),
    check(
      "ck_products_trial_duration_seconds",
      sql`${table.trialDurationSeconds} is null or ${table.trialDurationSeconds} > 0`,
    ),
    check(
      "ck_products_trial_features_json",
      sql`json_valid(${table.trialFeaturesJson}) and json_type(${table.trialFeaturesJson}) = 'array'`,
    ),
    check("ck_products_status", sql`${table.status} in ('active', 'archived')`),
    check(
      "ck_products_trial_configuration",
      sql`${table.trialEnabled} = 0 or ${table.trialDurationSeconds} is not null`,
    ),
  ],
);

export const productReleases = sqliteTable(
  "product_releases",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    productId: text("product_id").notNull(),
    version: text("version").notNull(),
    platform: text("platform").notNull(),
    description: text("description"),
    downloadUrl: text("download_url"),
    artifactSha256: text("artifact_sha256").notNull(),
    releasedAt: text("released_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_product_releases_instance_id").on(table.instanceId, table.id),
    unique("uq_product_releases_identity").on(
      table.instanceId,
      table.productId,
      table.version,
      table.platform,
    ),
    foreignKey({
      name: "fk_product_releases_product",
      columns: [table.instanceId, table.productId],
      foreignColumns: [products.instanceId, products.id],
    }).onDelete("restrict"),
    index("idx_product_releases_lookup").on(
      table.instanceId,
      table.productId,
      table.version,
      table.platform,
    ),
    check(
      "ck_product_releases_artifact_sha256",
      sql`length(${table.artifactSha256}) = 64
        and ${table.artifactSha256} = lower(${table.artifactSha256})
        and ${table.artifactSha256} not glob '*[^0-9a-f]*'`,
    ),
  ],
);

export const signingKeys = sqliteTable(
  "signing_keys",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    productId: text("product_id").notNull(),
    algorithm: text("algorithm").notNull().default("Ed25519"),
    source: text("source").notNull(),
    publicKey: text("public_key").notNull(),
    privateKeyCiphertext: text("private_key_ciphertext").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    retiredAt: text("retired_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    unique("uq_signing_keys_instance_id").on(table.instanceId, table.id),
    foreignKey({
      name: "fk_signing_keys_product",
      columns: [table.instanceId, table.productId],
      foreignColumns: [products.instanceId, products.id],
    }).onDelete("restrict"),
    index("idx_signing_keys_product_status").on(table.instanceId, table.productId, table.status),
    uniqueIndex("uq_signing_keys_product_active")
      .on(table.instanceId, table.productId)
      .where(sql`${table.status} = 'active'`),
    check("ck_signing_keys_algorithm", sql`${table.algorithm} = 'Ed25519'`),
    check("ck_signing_keys_source", sql`${table.source} in ('generated', 'uploaded')`),
    check("ck_signing_keys_status", sql`${table.status} in ('active', 'retired', 'revoked')`),
  ],
);

export const licensePlans = sqliteTable(
  "license_plans",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    productId: text("product_id").notNull(),
    name: text("name").notNull(),
    revision: integer("revision").notNull().default(1),
    licenseModel: text("license_model").notNull(),
    credentialMode: text("credential_mode").notNull(),
    defaultTermSeconds: integer("default_term_seconds"),
    updateWindowSeconds: integer("update_window_seconds"),
    signedTokenTtlSeconds: integer("signed_token_ttl_seconds").notNull().default(0),
    paymentGraceSeconds: integer("payment_grace_seconds").notNull(),
    maxActivations: integer("max_activations").notNull().default(1),
    featuresJson: text("features_json").notNull().default("[]"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_license_plans_instance_id").on(table.instanceId, table.id),
    unique("uq_license_plans_product_id").on(table.instanceId, table.productId, table.id),
    foreignKey({
      name: "fk_license_plans_product",
      columns: [table.instanceId, table.productId],
      foreignColumns: [products.instanceId, products.id],
    }).onDelete("restrict"),
    index("idx_license_plans_product_status").on(table.instanceId, table.productId, table.status),
    check("ck_license_plans_revision", sql`${table.revision} >= 1`),
    check(
      "ck_license_plans_license_model",
      sql`${table.licenseModel} in ('perpetual', 'fixed_term', 'subscription')`,
    ),
    check("ck_license_plans_credential_mode", sql`${table.credentialMode} in ('opaque', 'signed')`),
    check(
      "ck_license_plans_default_term_seconds",
      sql`${table.defaultTermSeconds} is null or ${table.defaultTermSeconds} > 0`,
    ),
    check(
      "ck_license_plans_update_window_seconds",
      sql`${table.updateWindowSeconds} is null or ${table.updateWindowSeconds} > 0`,
    ),
    check("ck_license_plans_signed_token_ttl", sql`${table.signedTokenTtlSeconds} >= 0`),
    check("ck_license_plans_payment_grace", sql`${table.paymentGraceSeconds} >= 0`),
    check("ck_license_plans_max_activations", sql`${table.maxActivations} >= 1`),
    check(
      "ck_license_plans_features_json",
      sql`json_valid(${table.featuresJson}) and json_type(${table.featuresJson}) = 'array'`,
    ),
    check("ck_license_plans_status", sql`${table.status} in ('active', 'archived')`),
    check(
      "ck_license_plans_term_model",
      sql`(${table.licenseModel} = 'fixed_term' and ${table.defaultTermSeconds} is not null)
        or (${table.licenseModel} in ('perpetual', 'subscription') and ${table.defaultTermSeconds} is null)`,
    ),
    check(
      "ck_license_plans_update_model",
      sql`${table.licenseModel} = 'perpetual' or ${table.updateWindowSeconds} is null`,
    ),
    check(
      "ck_license_plans_credential_ttl",
      sql`(${table.credentialMode} = 'opaque' and ${table.signedTokenTtlSeconds} = 0)
        or (${table.credentialMode} = 'signed' and ${table.signedTokenTtlSeconds} > 0)`,
    ),
    check(
      "ck_license_plans_payment_grace_model",
      sql`(${table.licenseModel} = 'subscription' and ${table.paymentGraceSeconds} >= 0)
        or (${table.licenseModel} in ('perpetual', 'fixed_term') and ${table.paymentGraceSeconds} = 0)`,
    ),
  ],
);

export const billingProviders = sqliteTable(
  "billing_providers",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    provider: text("provider").notNull(),
    environment: text("environment").notNull(),
    clientSideToken: text("client_side_token").notNull(),
    webhookSecretCiphertext: text("webhook_secret_ciphertext").notNull(),
    apiSecretCiphertext: text("api_secret_ciphertext"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_billing_providers_instance_id").on(table.instanceId, table.id),
    unique("uq_billing_providers_identity").on(table.instanceId, table.provider, table.environment),
    index("idx_billing_providers_instance_status").on(table.instanceId, table.status),
    check("ck_billing_providers_environment", sql`${table.environment} in ('sandbox', 'live')`),
    check("ck_billing_providers_status", sql`${table.status} in ('active', 'disabled')`),
    check(
      "ck_billing_providers_client_side_token",
      sql`(${table.environment} = 'sandbox' and substr(${table.clientSideToken}, 1, 5) = 'test_')
        or (${table.environment} = 'live' and substr(${table.clientSideToken}, 1, 5) = 'live_')`,
    ),
  ],
);

export const systemIssues = sqliteTable(
  "system_issues",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    category: text("category").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    operation: text("operation").notNull(),
    errorCode: text("error_code").notNull(),
    errorDetailJson: text("error_detail_json").notNull(),
    status: text("status").notNull().default("pending"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    processedAt: text("processed_at"),
    processedByUserId: text("processed_by_user_id").references(
      () => users.id,
      restrictReference,
    ),
  },
  (table) => [
    unique("uq_system_issues_instance_id").on(table.instanceId, table.id),
    unique("uq_system_issues_identity").on(
      table.instanceId,
      table.category,
      table.sourceType,
      table.sourceId,
      table.operation,
      table.errorCode,
    ),
    index("idx_system_issues_recent").on(
      table.instanceId,
      table.status,
      table.lastSeenAt,
    ),
    index("idx_system_issues_source").on(
      table.instanceId,
      table.category,
      table.sourceType,
      table.sourceId,
    ),
    check(
      "ck_system_issues_category",
      sql`${table.category} in ('billing', 'webhook', 'email')`,
    ),
    check("ck_system_issues_status", sql`${table.status} in ('pending', 'processed')`),
    check("ck_system_issues_occurrence_count", sql`${table.occurrenceCount} >= 1`),
    check("ck_system_issues_seen_order", sql`${table.lastSeenAt} >= ${table.firstSeenAt}`),
    check(
      "ck_system_issues_error_detail_json",
      sql`json_valid(${table.errorDetailJson}) and json_type(${table.errorDetailJson}) = 'object'`,
    ),
    check(
      "ck_system_issues_processing",
      sql`(${table.status} = 'pending'
          and ${table.processedAt} is null
          and ${table.processedByUserId} is null)
        or (${table.status} = 'processed'
          and ${table.processedAt} is not null
          and ${table.processedByUserId} is not null)`,
    ),
  ],
);

export const licenses = sqliteTable(
  "licenses",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    customerId: text("customer_id").notNull(),
    productId: text("product_id").notNull(),
    planId: text("plan_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    licenseModel: text("license_model").notNull(),
    renewalMode: text("renewal_mode").notNull(),
    credentialMode: text("credential_mode").notNull(),
    signedTokenTtlSeconds: integer("signed_token_ttl_seconds").notNull(),
    paymentGraceSeconds: integer("payment_grace_seconds").notNull(),
    maxActivations: integer("max_activations").notNull(),
    featuresJson: text("features_json").notNull().default("[]"),
    keyHash: text("key_hash").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    keyRotatedAt: text("key_rotated_at"),
    source: text("source").notNull().default("manual"),
    sourceBillingProviderId: text("source_billing_provider_id"),
    sourceExternalTransactionId: text("source_external_transaction_id"),
    isCheckoutVerification: integer("is_checkout_verification", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status").notNull().default("active"),
    statusReason: text("status_reason"),
    expiresAt: text("expires_at"),
    updatesUntil: text("updates_until"),
    suspendedAt: text("suspended_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_licenses_instance_id").on(table.instanceId, table.id),
    unique("uq_licenses_instance_key_hash").on(table.instanceId, table.keyHash),
    foreignKey({
      name: "fk_licenses_customer",
      columns: [table.instanceId, table.customerId],
      foreignColumns: [customers.instanceId, customers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_licenses_product",
      columns: [table.instanceId, table.productId],
      foreignColumns: [products.instanceId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_licenses_plan",
      columns: [table.instanceId, table.productId, table.planId],
      foreignColumns: [licensePlans.instanceId, licensePlans.productId, licensePlans.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_licenses_source_provider",
      columns: [table.instanceId, table.sourceBillingProviderId],
      foreignColumns: [billingProviders.instanceId, billingProviders.id],
    }).onDelete("restrict"),
    uniqueIndex("uq_licenses_source_transaction")
      .on(table.instanceId, table.sourceBillingProviderId, table.sourceExternalTransactionId)
      .where(
        sql`${table.sourceBillingProviderId} is not null and ${table.sourceExternalTransactionId} is not null`,
      ),
    index("idx_licenses_instance_status").on(
      table.instanceId,
      table.status,
      sql`${table.createdAt} desc`,
    ),
    index("idx_licenses_product_plan").on(table.instanceId, table.productId, table.planId),
    index("idx_licenses_customer").on(
      table.instanceId,
      table.customerId,
      sql`${table.createdAt} desc`,
    ),
    check("ck_licenses_plan_revision", sql`${table.planRevision} >= 1`),
    check(
      "ck_licenses_license_model",
      sql`${table.licenseModel} in ('perpetual', 'fixed_term', 'subscription')`,
    ),
    check("ck_licenses_renewal_mode", sql`${table.renewalMode} in ('none', 'manual', 'billing')`),
    check("ck_licenses_credential_mode", sql`${table.credentialMode} in ('opaque', 'signed')`),
    check("ck_licenses_signed_token_ttl", sql`${table.signedTokenTtlSeconds} >= 0`),
    check("ck_licenses_payment_grace", sql`${table.paymentGraceSeconds} >= 0`),
    check("ck_licenses_max_activations", sql`${table.maxActivations} >= 1`),
    check(
      "ck_licenses_features_json",
      sql`json_valid(${table.featuresJson}) and json_type(${table.featuresJson}) = 'array'`,
    ),
    check("ck_licenses_key_version", sql`${table.keyVersion} >= 1`),
    check("ck_licenses_source", sql`${table.source} in ('manual', 'api', 'payment')`),
    check("ck_licenses_verification", sql`${table.isCheckoutVerification} in (0, 1)`),
    check("ck_licenses_status", sql`${table.status} in ('active', 'suspended', 'revoked')`),
    check(
      "ck_licenses_expiry_model",
      sql`(${table.licenseModel} = 'perpetual' and ${table.expiresAt} is null)
        or (${table.licenseModel} in ('fixed_term', 'subscription') and ${table.expiresAt} is not null)`,
    ),
    check(
      "ck_licenses_update_model",
      sql`${table.licenseModel} = 'perpetual' or ${table.updatesUntil} is null`,
    ),
    check(
      "ck_licenses_credential_ttl",
      sql`(${table.credentialMode} = 'opaque' and ${table.signedTokenTtlSeconds} = 0)
        or (${table.credentialMode} = 'signed' and ${table.signedTokenTtlSeconds} > 0)`,
    ),
    check(
      "ck_licenses_payment_grace_model",
      sql`(${table.licenseModel} = 'subscription' and ${table.paymentGraceSeconds} >= 0)
        or (${table.licenseModel} in ('perpetual', 'fixed_term') and ${table.paymentGraceSeconds} = 0)`,
    ),
    check(
      "ck_licenses_source_reference",
      sql`(${table.source} = 'payment'
          and ${table.sourceBillingProviderId} is not null
          and ${table.sourceExternalTransactionId} is not null)
        or (${table.source} in ('manual', 'api')
          and ${table.sourceBillingProviderId} is null
          and ${table.sourceExternalTransactionId} is null)`,
    ),
    check(
      "ck_licenses_checkout_verification",
      sql`${table.isCheckoutVerification} = 0
        or (${table.source} = 'payment'
          and ${table.status} = 'suspended'
          and ${table.statusReason} = 'checkout_verification')`,
    ),
    check(
      "ck_licenses_renewal_authority",
      sql`(${table.licenseModel} in ('perpetual', 'fixed_term') and ${table.renewalMode} = 'none')
        or (${table.licenseModel} = 'subscription'
          and ${table.renewalMode} = 'manual'
          and ${table.source} in ('manual', 'api'))
        or (${table.licenseModel} = 'subscription'
          and ${table.renewalMode} = 'billing'
          and ${table.source} = 'payment')`,
    ),
    check(
      "ck_licenses_manual_expiry",
      sql`${table.renewalMode} <> 'manual' or ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "ck_licenses_billing_grace",
      sql`${table.renewalMode} = 'billing' or ${table.paymentGraceSeconds} = 0`,
    ),
  ],
);

export const activations = sqliteTable(
  "activations",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    licenseId: text("license_id").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    machineTokenHash: text("machine_token_hash").notNull(),
    name: text("name"),
    platform: text("platform"),
    firstIp: text("first_ip"),
    status: text("status").notNull().default("active"),
    activatedAt: text("activated_at").notNull(),
    lastValidatedAt: text("last_validated_at"),
    deactivatedAt: text("deactivated_at"),
    revokedAt: text("revoked_at"),
    revokeReason: text("revoke_reason"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_activations_instance_id").on(table.instanceId, table.id),
    foreignKey({
      name: "fk_activations_license",
      columns: [table.instanceId, table.licenseId],
      foreignColumns: [licenses.instanceId, licenses.id],
    }).onDelete("restrict"),
    index("idx_activations_license_status").on(table.instanceId, table.licenseId, table.status),
    index("idx_activations_token_hash").on(table.instanceId, table.machineTokenHash),
    uniqueIndex("uq_activations_active_fingerprint")
      .on(table.instanceId, table.licenseId, table.fingerprintHash)
      .where(sql`${table.status} = 'active'`),
    check("ck_activations_status", sql`${table.status} in ('active', 'deactivated', 'revoked')`),
  ],
);

export const trialClaims = sqliteTable(
  "trial_claims",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    productId: text("product_id").notNull(),
    fingerprintHash: text("fingerprint_hash").notNull(),
    trialTokenHash: text("trial_token_hash").notNull(),
    featuresJson: text("features_json").notNull().default("[]"),
    claimedAt: text("claimed_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastValidatedAt: text("last_validated_at"),
    revokedAt: text("revoked_at"),
    revokeReason: text("revoke_reason"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_trial_claims_instance_id").on(table.instanceId, table.id),
    unique("uq_trial_claims_token_hash").on(table.instanceId, table.trialTokenHash),
    unique("uq_trial_claims_device").on(table.instanceId, table.productId, table.fingerprintHash),
    foreignKey({
      name: "fk_trial_claims_product",
      columns: [table.instanceId, table.productId],
      foreignColumns: [products.instanceId, products.id],
    }).onDelete("restrict"),
    index("idx_trial_claims_lookup").on(table.instanceId, table.productId, table.id),
    index("idx_trial_claims_expiry").on(
      table.instanceId,
      table.productId,
      table.expiresAt,
      table.revokedAt,
    ),
    check(
      "ck_trial_claims_features_json",
      sql`json_valid(${table.featuresJson}) and json_type(${table.featuresJson}) = 'array'`,
    ),
    check("ck_trial_claims_expiry", sql`${table.expiresAt} > ${table.claimedAt}`),
    check(
      "ck_trial_claims_revocation",
      sql`(${table.revokedAt} is null and ${table.revokeReason} is null)
        or (${table.revokedAt} is not null and ${table.revokeReason} is not null)`,
    ),
  ],
);

export const billingCustomers = sqliteTable(
  "billing_customers",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    billingProviderId: text("billing_provider_id").notNull(),
    customerId: text("customer_id"),
    externalCustomerId: text("external_customer_id").notNull(),
    providerEmail: nocaseText("provider_email").notNull(),
    providerName: text("provider_name"),
    providerStatus: text("provider_status").notNull(),
    linkStatus: text("link_status").notNull(),
    lastSyncSource: text("last_sync_source").notNull(),
    externalUpdatedAt: text("external_updated_at").notNull(),
    lastExternalEventId: text("last_external_event_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_billing_customers_instance_id").on(table.instanceId, table.id),
    unique("uq_billing_customers_instance_provider_customer").on(
      table.instanceId,
      table.billingProviderId,
      table.externalCustomerId,
    ),
    foreignKey({
      name: "fk_billing_customers_provider",
      columns: [table.instanceId, table.billingProviderId],
      foreignColumns: [billingProviders.instanceId, billingProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_billing_customers_customer",
      columns: [table.instanceId, table.customerId],
      foreignColumns: [customers.instanceId, customers.id],
    }).onDelete("restrict"),
    index("idx_billing_customers_customer").on(
      table.instanceId,
      table.customerId,
      sql`${table.updatedAt} desc`,
    ),
    index("idx_billing_customers_link_status").on(
      table.instanceId,
      table.billingProviderId,
      table.linkStatus,
      table.updatedAt,
    ),
    check("ck_billing_customers_provider_status", sql`${table.providerStatus} in ('active', 'archived')`),
    check(
      "ck_billing_customers_link_status",
      sql`${table.linkStatus} in ('pending', 'linked', 'email_mismatch', 'needs_attention')`,
    ),
    check(
      "ck_billing_customers_sync_source",
      sql`${table.lastSyncSource} in ('webhook', 'api', 'reconciliation')`,
    ),
    check(
      "ck_billing_customers_link",
      sql`(${table.customerId} is null and ${table.linkStatus} in ('pending', 'needs_attention'))
        or (${table.customerId} is not null and ${table.linkStatus} in ('linked', 'email_mismatch'))`,
    ),
  ],
);

export const billingOffers = sqliteTable(
  "billing_offers",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    billingProviderId: text("billing_provider_id").notNull(),
    externalPriceId: text("external_price_id").notNull(),
    productId: text("product_id").notNull(),
    licensePlanId: text("license_plan_id").notNull(),
    purchaseType: text("purchase_type").notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_billing_offers_instance_id").on(table.instanceId, table.id),
    unique("uq_billing_offers_price").on(
      table.instanceId,
      table.billingProviderId,
      table.externalPriceId,
    ),
    foreignKey({
      name: "fk_billing_offers_provider",
      columns: [table.instanceId, table.billingProviderId],
      foreignColumns: [billingProviders.instanceId, billingProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_billing_offers_product",
      columns: [table.instanceId, table.productId],
      foreignColumns: [products.instanceId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_billing_offers_plan",
      columns: [table.instanceId, table.productId, table.licensePlanId],
      foreignColumns: [licensePlans.instanceId, licensePlans.productId, licensePlans.id],
    }).onDelete("restrict"),
    index("idx_billing_offers_plan_status").on(table.instanceId, table.licensePlanId, table.status),
    check("ck_billing_offers_purchase_type", sql`${table.purchaseType} in ('one_time', 'subscription')`),
    check("ck_billing_offers_status", sql`${table.status} in ('draft', 'active', 'archived')`),
  ],
);

export const billingSubscriptions = sqliteTable(
  "billing_subscriptions",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    billingProviderId: text("billing_provider_id").notNull(),
    licenseId: text("license_id").notNull(),
    externalSubscriptionId: text("external_subscription_id").notNull(),
    externalCustomerId: text("external_customer_id").notNull(),
    externalPriceId: text("external_price_id").notNull(),
    status: text("status").notNull(),
    currentPeriodStart: text("current_period_start"),
    currentPeriodEnd: text("current_period_end"),
    nextBilledAt: text("next_billed_at"),
    trialType: text("trial_type"),
    trialStartedAt: text("trial_started_at"),
    trialEndsAt: text("trial_ends_at"),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
    lastExternalOccurredAt: text("last_external_occurred_at"),
    lastExternalEventId: text("last_external_event_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_billing_subscriptions_instance_id").on(table.instanceId, table.id),
    unique("uq_billing_subscriptions_external").on(
      table.instanceId,
      table.billingProviderId,
      table.externalSubscriptionId,
    ),
    unique("uq_billing_subscriptions_license").on(table.instanceId, table.licenseId),
    foreignKey({
      name: "fk_billing_subscriptions_provider",
      columns: [table.instanceId, table.billingProviderId],
      foreignColumns: [billingProviders.instanceId, billingProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_billing_subscriptions_customer",
      columns: [table.instanceId, table.billingProviderId, table.externalCustomerId],
      foreignColumns: [
        billingCustomers.instanceId,
        billingCustomers.billingProviderId,
        billingCustomers.externalCustomerId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_billing_subscriptions_license",
      columns: [table.instanceId, table.licenseId],
      foreignColumns: [licenses.instanceId, licenses.id],
    }).onDelete("restrict"),
    index("idx_billing_subscriptions_status_period").on(
      table.instanceId,
      table.status,
      table.currentPeriodEnd,
    ),
    check(
      "ck_billing_subscriptions_status",
      sql`${table.status} in ('trialing', 'active', 'past_due', 'paused', 'canceled')`,
    ),
    check(
      "ck_billing_subscriptions_trial_type",
      sql`${table.trialType} is null or ${table.trialType} = 'free_payment_method_required'`,
    ),
    check("ck_billing_subscriptions_cancel", sql`${table.cancelAtPeriodEnd} in (0, 1)`),
    check(
      "ck_billing_subscriptions_trial_fields",
      sql`(${table.trialType} is null
          and ${table.trialStartedAt} is null
          and ${table.trialEndsAt} is null)
        or (${table.trialType} is not null
          and ${table.trialStartedAt} is not null
          and ${table.trialEndsAt} is not null
          and ${table.trialEndsAt} > ${table.trialStartedAt})`,
    ),
    check(
      "ck_billing_subscriptions_trialing",
      sql`${table.status} <> 'trialing'
        or (${table.trialType} = 'free_payment_method_required'
          and ${table.trialStartedAt} is not null
          and ${table.trialEndsAt} is not null
          and ${table.nextBilledAt} is not null)`,
    ),
  ],
);

export const billingAdjustments = sqliteTable(
  "billing_adjustments",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    billingProviderId: text("billing_provider_id").notNull(),
    licenseId: text("license_id"),
    externalAdjustmentId: text("external_adjustment_id").notNull(),
    externalTransactionId: text("external_transaction_id").notNull(),
    externalSubscriptionId: text("external_subscription_id"),
    externalCustomerId: text("external_customer_id").notNull(),
    providerAction: text("provider_action").notNull(),
    adjustmentType: text("adjustment_type"),
    providerStatus: text("provider_status").notNull(),
    currencyCode: text("currency_code").notNull(),
    totalAmount: text("total_amount").notNull(),
    providerReason: text("provider_reason"),
    automaticEffect: text("automatic_effect").notNull().default("none"),
    reviewStatus: text("review_status").notNull(),
    resolutionAction: text("resolution_action"),
    resolutionReason: text("resolution_reason"),
    resolvedByUserId: text("resolved_by_user_id").references(
      () => users.id,
      restrictReference,
    ),
    resolvedAt: text("resolved_at"),
    lastExternalOccurredAt: text("last_external_occurred_at").notNull(),
    lastExternalEventId: text("last_external_event_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_billing_adjustments_instance_id").on(table.instanceId, table.id),
    unique("uq_billing_adjustments_external").on(
      table.instanceId,
      table.billingProviderId,
      table.externalAdjustmentId,
    ),
    foreignKey({
      name: "fk_billing_adjustments_provider",
      columns: [table.instanceId, table.billingProviderId],
      foreignColumns: [billingProviders.instanceId, billingProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_billing_adjustments_license",
      columns: [table.instanceId, table.licenseId],
      foreignColumns: [licenses.instanceId, licenses.id],
    }).onDelete("restrict"),
    index("idx_billing_adjustments_review").on(
      table.instanceId,
      table.reviewStatus,
      sql`${table.updatedAt} desc`,
    ),
    index("idx_billing_adjustments_transaction").on(
      table.instanceId,
      table.billingProviderId,
      table.externalTransactionId,
      sql`${table.updatedAt} desc`,
    ),
    check(
      "ck_billing_adjustments_action",
      sql`${table.providerAction} in (
        'credit', 'refund', 'chargeback', 'chargeback_reverse',
        'chargeback_warning', 'chargeback_warning_reverse', 'credit_reverse'
      )`,
    ),
    check(
      "ck_billing_adjustments_type",
      sql`${table.adjustmentType} is null or ${table.adjustmentType} in ('full', 'partial')`,
    ),
    check(
      "ck_billing_adjustments_provider_status",
      sql`${table.providerStatus} in ('pending_approval', 'approved', 'rejected', 'reversed')`,
    ),
    check(
      "ck_billing_adjustments_automatic_effect",
      sql`${table.automaticEffect} in ('none', 'license_suspended')`,
    ),
    check(
      "ck_billing_adjustments_review_status",
      sql`${table.reviewStatus} in ('not_required', 'open', 'resolved')`,
    ),
    check(
      "ck_billing_adjustments_resolution_action",
      sql`${table.resolutionAction} is null or ${table.resolutionAction} in (
        'no_action', 'keep_suspended', 'reinstate', 'revoke', 'security_reset'
      )`,
    ),
    check(
      "ck_billing_adjustments_effect_license",
      sql`${table.automaticEffect} = 'none' or ${table.licenseId} is not null`,
    ),
    check(
      "ck_billing_adjustments_not_required",
      sql`${table.reviewStatus} <> 'not_required' or ${table.automaticEffect} = 'none'`,
    ),
    check(
      "ck_billing_adjustments_resolution",
      sql`(${table.reviewStatus} in ('not_required', 'open')
          and ${table.resolutionAction} is null
          and ${table.resolutionReason} is null
          and ${table.resolvedByUserId} is null
          and ${table.resolvedAt} is null)
        or (${table.reviewStatus} = 'resolved'
          and ${table.resolutionAction} is not null
          and ${table.resolutionReason} is not null
          and ${table.resolvedByUserId} is not null
          and ${table.resolvedAt} is not null)`,
    ),
  ],
);

export const inboundEvents = sqliteTable(
  "inbound_events",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    billingProviderId: text("billing_provider_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    externalEventType: text("external_event_type").notNull(),
    externalCustomerId: text("external_customer_id"),
    externalTransactionId: text("external_transaction_id"),
    externalSubscriptionId: text("external_subscription_id"),
    externalAdjustmentId: text("external_adjustment_id"),
    externalOccurredAt: text("external_occurred_at"),
    payloadCiphertext: text("payload_ciphertext"),
    payloadHash: text("payload_hash").notNull(),
    payloadExpiresAt: text("payload_expires_at").notNull(),
    payloadClearedAt: text("payload_cleared_at"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    lockedBy: text("locked_by"),
    lockedUntil: text("locked_until"),
    resultType: text("result_type"),
    resultReferenceId: text("result_reference_id"),
    lastErrorCode: text("last_error_code"),
    lastErrorDetail: text("last_error_detail"),
    receivedAt: text("received_at").notNull(),
    processedAt: text("processed_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_inbound_events_instance_id").on(table.instanceId, table.id),
    unique("uq_inbound_events_external").on(
      table.instanceId,
      table.billingProviderId,
      table.externalEventId,
    ),
    foreignKey({
      name: "fk_inbound_events_provider",
      columns: [table.instanceId, table.billingProviderId],
      foreignColumns: [billingProviders.instanceId, billingProviders.id],
    }).onDelete("restrict"),
    index("idx_inbound_events_status_schedule").on(
      table.instanceId,
      table.status,
      table.nextAttemptAt,
      table.lockedUntil,
      table.receivedAt,
    ),
    index("idx_inbound_events_provider_type").on(
      table.instanceId,
      table.billingProviderId,
      table.externalEventType,
      sql`${table.receivedAt} desc`,
    ),
    index("idx_inbound_events_customer")
      .on(
        table.instanceId,
        table.billingProviderId,
        table.externalCustomerId,
        sql`${table.receivedAt} desc`,
      )
      .where(sql`${table.externalCustomerId} is not null`),
    index("idx_inbound_events_transaction")
      .on(
        table.instanceId,
        table.billingProviderId,
        table.externalTransactionId,
        sql`${table.receivedAt} desc`,
      )
      .where(sql`${table.externalTransactionId} is not null`),
    index("idx_inbound_events_subscription")
      .on(
        table.instanceId,
        table.billingProviderId,
        table.externalSubscriptionId,
        sql`${table.receivedAt} desc`,
      )
      .where(sql`${table.externalSubscriptionId} is not null`),
    index("idx_inbound_events_adjustment")
      .on(
        table.instanceId,
        table.billingProviderId,
        table.externalAdjustmentId,
        sql`${table.receivedAt} desc`,
      )
      .where(sql`${table.externalAdjustmentId} is not null`),
    index("idx_inbound_events_payload_retention")
      .on(table.payloadExpiresAt, table.id)
      .where(sql`${table.payloadCiphertext} is not null`),
    check(
      "ck_inbound_events_status",
      sql`${table.status} in ('pending', 'processing', 'processed', 'failed', 'needs_attention')`,
    ),
    check("ck_inbound_events_attempt_count", sql`${table.attemptCount} >= 0`),
  ],
);

export const emailIntegrations = sqliteTable(
  "email_integrations",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    defaultFromEmail: nocaseText("default_from_email").notNull(),
    defaultFromName: text("default_from_name"),
    replyToEmail: nocaseText("reply_to_email"),
    maxAutomaticAttempts: integer("max_automatic_attempts").notNull().default(4),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_email_integrations_instance_id").on(table.instanceId, table.id),
    uniqueIndex("uq_email_integrations_active_instance")
      .on(table.instanceId)
      .where(sql`${table.status} = 'active'`),
    index("idx_email_integrations_instance_status").on(table.instanceId, table.status),
    check("ck_email_integrations_provider", sql`${table.provider} = 'resend'`),
    check(
      "ck_email_integrations_max_attempts",
      sql`${table.maxAutomaticAttempts} between 1 and 20`,
    ),
    check("ck_email_integrations_status", sql`${table.status} in ('active', 'disabled')`),
  ],
);

export const emailTemplateBindings = sqliteTable(
  "email_template_bindings",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    emailIntegrationId: text("email_integration_id").notNull(),
    notificationType: text("notification_type").notNull(),
    contractVersion: integer("contract_version").notNull(),
    providerTemplateRef: text("provider_template_ref").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table): SQLiteTableExtraConfigValue[] => [
    unique("uq_email_template_bindings_instance_id").on(table.instanceId, table.id),
    unique("uq_email_template_bindings_integration_id").on(
      table.instanceId,
      table.emailIntegrationId,
      table.id,
    ),
    unique("uq_email_template_bindings_contract").on(
      table.instanceId,
      table.emailIntegrationId,
      table.notificationType,
    ),
    foreignKey({
      name: "fk_email_template_bindings_integration",
      columns: [table.instanceId, table.emailIntegrationId],
      foreignColumns: [emailIntegrations.instanceId, emailIntegrations.id],
    }).onDelete("restrict"),
    index("idx_email_template_bindings_lookup").on(
      table.instanceId,
      table.emailIntegrationId,
      table.notificationType,
      table.contractVersion,
      table.status,
    ),
    check("ck_email_template_bindings_contract_version", sql`${table.contractVersion} >= 1`),
    check(
      "ck_email_template_bindings_template_ref",
      sql`length(trim(${table.providerTemplateRef})) > 0`,
    ),
    check("ck_email_template_bindings_status", sql`${table.status} in ('active', 'disabled')`),
  ],
);

export const emailDeliveries = sqliteTable(
  "email_deliveries",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    recipientType: text("recipient_type").notNull(),
    customerId: text("customer_id"),
    notificationType: text("notification_type").notNull(),
    contractVersion: integer("contract_version").notNull(),
    recipientEmail: nocaseText("recipient_email").notNull(),
    variablesCiphertext: text("variables_ciphertext"),
    sendExpiresAt: text("send_expires_at"),
    variablesExpiresAt: text("variables_expires_at"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    providerMessageId: text("provider_message_id"),
    lastErrorJson: text("last_error_json"),
    lockedBy: text("locked_by"),
    lockedUntil: text("locked_until"),
    acceptedAt: text("accepted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_email_deliveries_instance_id").on(table.instanceId, table.id),
    unique("uq_email_deliveries_customer_id").on(table.instanceId, table.customerId, table.id),
    foreignKey({
      name: "fk_email_deliveries_customer",
      columns: [table.instanceId, table.customerId],
      foreignColumns: [customers.instanceId, customers.id],
    }).onDelete("restrict"),
    index("idx_email_deliveries_status_schedule").on(
      table.instanceId,
      table.status,
      table.nextAttemptAt,
      table.lockedUntil,
      table.createdAt,
    ),
    index("idx_email_deliveries_customer").on(
      table.instanceId,
      table.customerId,
      sql`${table.createdAt} desc`,
    ),
    check("ck_email_deliveries_contract_version", sql`${table.contractVersion} >= 1`),
    check(
      "ck_email_deliveries_recipient",
      sql`(${table.recipientType} = 'customer' and ${table.customerId} is not null)
        or (${table.recipientType} = 'instance_invitation' and ${table.customerId} is null)`,
    ),
    check(
      "ck_email_deliveries_status",
      sql`${table.status} in (
        'pending', 'processing', 'waiting_configuration', 'retry_scheduled',
        'accepted', 'failed', 'expired', 'cancelled'
      )`,
    ),
    check("ck_email_deliveries_attempt_count", sql`${table.attemptCount} >= 0`),
    check(
      "ck_email_deliveries_last_error_json",
      sql`${table.lastErrorJson} is null
        or (json_valid(${table.lastErrorJson}) and json_type(${table.lastErrorJson}) = 'object')`,
    ),
    check(
      "ck_email_deliveries_lock",
      sql`(${table.status} = 'processing'
          and ${table.lockedBy} is not null
          and ${table.lockedUntil} is not null)
        or (${table.status} <> 'processing'
          and ${table.lockedBy} is null
          and ${table.lockedUntil} is null)`,
    ),
    check(
      "ck_email_deliveries_acceptance",
      sql`(${table.status} = 'accepted'
          and ${table.providerMessageId} is not null
          and ${table.acceptedAt} is not null
          and ${table.lastErrorJson} is null)
        or (${table.status} <> 'accepted'
          and ${table.providerMessageId} is null
          and ${table.acceptedAt} is null)`,
    ),
    check(
      "ck_email_deliveries_variables",
      sql`(${table.status} in ('expired', 'cancelled') and ${table.variablesCiphertext} is null)
        or (${table.status} in (
          'pending', 'processing', 'waiting_configuration', 'retry_scheduled', 'failed'
        ) and ${table.variablesCiphertext} is not null)
        or (${table.status} = 'accepted')`,
    ),
    check(
      "ck_email_deliveries_retention",
      sql`(${table.status} = 'accepted' and ${table.variablesExpiresAt} is not null)
        or (${table.status} <> 'accepted' and ${table.variablesExpiresAt} is null)`,
    ),
    index("idx_email_deliveries_payload_retention")
      .on(table.variablesExpiresAt, table.id)
      .where(sql`${table.status} = 'accepted' and ${table.variablesCiphertext} is not null`),
  ],
);

export const instanceInvitations = sqliteTable(
  "instance_invitations",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    email: nocaseText("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => users.id, restrictReference),
    acceptedByUserId: text("accepted_by_user_id").references(
      () => users.id,
      restrictReference,
    ),
    deliveryId: text("delivery_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_instance_invitations_instance_id").on(table.instanceId, table.id),
    unique("uq_instance_invitations_token_hash").on(table.tokenHash),
    unique("uq_instance_invitations_delivery").on(table.instanceId, table.deliveryId),
    uniqueIndex("uq_instance_invitations_pending_email")
      .on(table.instanceId, table.email)
      .where(sql`${table.status} = 'pending'`),
    foreignKey({
      name: "fk_instance_invitations_delivery",
      columns: [table.instanceId, table.deliveryId],
      foreignColumns: [emailDeliveries.instanceId, emailDeliveries.id],
    }).onDelete("restrict"),
    index("idx_instance_invitations_status_expiry").on(
      table.instanceId,
      table.status,
      table.expiresAt,
    ),
    index("idx_instance_invitations_invited_by").on(
      table.instanceId,
      table.invitedByUserId,
      sql`${table.createdAt} desc`,
    ),
    check(
      "ck_instance_invitations_role",
      sql`${table.role} in ('owner', 'admin', 'member', 'viewer')`,
    ),
    check(
      "ck_instance_invitations_status",
      sql`${table.status} in ('pending', 'accepted', 'revoked', 'expired')`,
    ),
    check(
      "ck_instance_invitations_expiry",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "ck_instance_invitations_terminal_state",
      sql`(${table.status} in ('pending', 'expired')
          and ${table.acceptedByUserId} is null
          and ${table.acceptedAt} is null
          and ${table.revokedAt} is null)
        or (${table.status} = 'accepted'
          and ${table.acceptedByUserId} is not null
          and ${table.acceptedAt} is not null
          and ${table.revokedAt} is null)
        or (${table.status} = 'revoked'
          and ${table.acceptedByUserId} is null
          and ${table.acceptedAt} is null
          and ${table.revokedAt} is not null)`,
    ),
  ],
);

export const instanceMemberships = sqliteTable(
  "instance_memberships",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, restrictReference),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    joinedByInvitationId: text("joined_by_invitation_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_instance_memberships",
      columns: [table.instanceId, table.userId],
    }),
    unique("uq_instance_memberships_invitation").on(
      table.instanceId,
      table.joinedByInvitationId,
    ),
    foreignKey({
      name: "fk_instance_memberships_invitation",
      columns: [table.instanceId, table.joinedByInvitationId],
      foreignColumns: [instanceInvitations.instanceId, instanceInvitations.id],
    }).onDelete("restrict"),
    index("idx_instance_memberships_user_status").on(table.userId, table.status),
    index("idx_instance_memberships_instance_status").on(
      table.instanceId,
      table.status,
      table.role,
    ),
    index("idx_instance_memberships_active_owner")
      .on(table.instanceId)
      .where(sql`${table.role} = 'owner' and ${table.status} = 'active'`),
    check(
      "ck_instance_memberships_role",
      sql`${table.role} in ('owner', 'admin', 'member', 'viewer')`,
    ),
    check(
      "ck_instance_memberships_status",
      sql`${table.status} in ('active', 'disabled', 'removed')`,
    ),
  ],
);

export const customerLoginChallenges = sqliteTable(
  "customer_login_challenges",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    customerId: text("customer_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    revokedAt: text("revoked_at"),
    deliveryId: text("delivery_id").notNull(),
    requestedIp: text("requested_ip"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    unique("uq_customer_login_challenges_instance_id").on(table.instanceId, table.id),
    unique("uq_customer_login_challenges_customer_id").on(
      table.instanceId,
      table.customerId,
      table.id,
    ),
    unique("uq_customer_login_challenges_token_hash").on(table.tokenHash),
    foreignKey({
      name: "fk_customer_login_challenges_customer",
      columns: [table.instanceId, table.customerId],
      foreignColumns: [customers.instanceId, customers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_customer_login_challenges_delivery",
      columns: [table.instanceId, table.customerId, table.deliveryId],
      foreignColumns: [
        emailDeliveries.instanceId,
        emailDeliveries.customerId,
        emailDeliveries.id,
      ],
    }).onDelete("restrict"),
    index("idx_customer_login_challenges_customer").on(
      table.instanceId,
      table.customerId,
      sql`${table.createdAt} desc`,
    ),
    index("idx_customer_login_challenges_lookup").on(table.instanceId, table.tokenHash),
    index("idx_customer_login_challenges_expiry").on(
      table.instanceId,
      table.expiresAt,
      table.consumedAt,
      table.revokedAt,
    ),
  ],
);

export const customerSessions = sqliteTable(
  "customer_sessions",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    customerId: text("customer_id").notNull(),
    loginChallengeId: text("login_challenge_id").notNull(),
    sessionTokenHash: text("session_token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    unique("uq_customer_sessions_instance_id").on(table.instanceId, table.id),
    unique("uq_customer_sessions_challenge").on(table.instanceId, table.loginChallengeId),
    unique("uq_customer_sessions_token_hash").on(table.sessionTokenHash),
    unique("uq_customer_sessions_csrf_token_hash").on(table.csrfTokenHash),
    foreignKey({
      name: "fk_customer_sessions_customer",
      columns: [table.instanceId, table.customerId],
      foreignColumns: [customers.instanceId, customers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_customer_sessions_challenge",
      columns: [table.instanceId, table.customerId, table.loginChallengeId],
      foreignColumns: [
        customerLoginChallenges.instanceId,
        customerLoginChallenges.customerId,
        customerLoginChallenges.id,
      ],
    }).onDelete("restrict"),
    index("idx_customer_sessions_customer_expiry").on(
      table.instanceId,
      table.customerId,
      table.expiresAt,
    ),
    index("idx_customer_sessions_lookup").on(table.instanceId, table.sessionTokenHash),
  ],
);

export const licenseKeyRotations = sqliteTable(
  "license_key_rotations",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    licenseId: text("license_id").notNull(),
    fromVersion: integer("from_version").notNull(),
    toVersion: integer("to_version").notNull(),
    reason: text("reason").notNull(),
    revokedActivations: integer("revoked_activations", { mode: "boolean" })
      .notNull()
      .default(false),
    initiatedByUserId: text("initiated_by_user_id").references(
      () => users.id,
      restrictReference,
    ),
    initiatedByCustomerId: text("initiated_by_customer_id"),
    deliveryId: text("delivery_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    unique("uq_license_key_rotations_instance_id").on(table.instanceId, table.id),
    foreignKey({
      name: "fk_license_key_rotations_license",
      columns: [table.instanceId, table.licenseId],
      foreignColumns: [licenses.instanceId, licenses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_license_key_rotations_customer",
      columns: [table.instanceId, table.initiatedByCustomerId],
      foreignColumns: [customers.instanceId, customers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_license_key_rotations_delivery",
      columns: [table.instanceId, table.deliveryId],
      foreignColumns: [emailDeliveries.instanceId, emailDeliveries.id],
    }).onDelete("restrict"),
    index("idx_license_key_rotations_license").on(
      table.instanceId,
      table.licenseId,
      sql`${table.createdAt} desc`,
    ),
    check("ck_license_key_rotations_from", sql`${table.fromVersion} >= 1`),
    check("ck_license_key_rotations_to", sql`${table.toVersion} > ${table.fromVersion}`),
    check(
      "ck_license_key_rotations_reason",
      sql`${table.reason} in ('recovery', 'security_reset', 'admin')`,
    ),
    check("ck_license_key_rotations_revoked", sql`${table.revokedActivations} in (0, 1)`),
    check(
      "ck_license_key_rotations_initiator",
      sql`${table.initiatedByUserId} is null or ${table.initiatedByCustomerId} is null`,
    ),
  ],
);

export const billingCheckoutVerifications = sqliteTable(
  "billing_checkout_verifications",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, restrictReference),
    billingOfferId: text("billing_offer_id").notNull(),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => users.id, restrictReference),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    externalTransactionId: text("external_transaction_id"),
    licenseId: text("license_id"),
    deliveryId: text("delivery_id"),
    expiresAt: text("expires_at").notNull(),
    completedAt: text("completed_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorDetail: text("last_error_detail"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique("uq_billing_checkout_verifications_instance_id").on(table.instanceId, table.id),
    unique("uq_billing_checkout_verifications_token_hash").on(table.tokenHash),
    uniqueIndex("uq_billing_checkout_verifications_transaction")
      .on(table.instanceId, table.billingOfferId, table.externalTransactionId)
      .where(sql`${table.externalTransactionId} is not null`),
    foreignKey({
      name: "fk_billing_checkout_verifications_offer",
      columns: [table.instanceId, table.billingOfferId],
      foreignColumns: [billingOffers.instanceId, billingOffers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_billing_checkout_verifications_license",
      columns: [table.instanceId, table.licenseId],
      foreignColumns: [licenses.instanceId, licenses.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_billing_checkout_verifications_delivery",
      columns: [table.instanceId, table.deliveryId],
      foreignColumns: [emailDeliveries.instanceId, emailDeliveries.id],
    }).onDelete("restrict"),
    index("idx_billing_checkout_verifications_status_expiry").on(
      table.instanceId,
      table.status,
      table.expiresAt,
    ),
    index("idx_billing_checkout_verifications_offer").on(
      table.instanceId,
      table.billingOfferId,
      sql`${table.completedAt} desc`,
    ),
    check(
      "ck_billing_checkout_verifications_status",
      sql`${table.status} in ('pending', 'delivery_pending', 'completed', 'needs_attention', 'expired', 'cancelled')`,
    ),
    check(
      "ck_billing_checkout_verifications_expiry",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "ck_billing_checkout_verifications_evidence",
      sql`${table.status} not in ('delivery_pending', 'completed')
        or (${table.externalTransactionId} is not null
          and ${table.licenseId} is not null
          and ${table.deliveryId} is not null)`,
    ),
    check(
      "ck_billing_checkout_verifications_completed",
      sql`(${table.status} = 'completed' and ${table.completedAt} is not null)
        or (${table.status} <> 'completed' and ${table.completedAt} is null)`,
    ),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    scopeType: text("scope_type").notNull(),
    instanceId: text("instance_id").references(() => instances.id, restrictReference),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, restrictReference),
    actorCustomerId: text("actor_customer_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    requestId: text("request_id"),
    detailsRedactedJson: text("details_redacted_json").notNull().default("{}"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "fk_audit_logs_customer",
      columns: [table.instanceId, table.actorCustomerId],
      foreignColumns: [customers.instanceId, customers.id],
    }).onDelete("restrict"),
    index("idx_audit_logs_instance_created").on(
      table.instanceId,
      sql`${table.createdAt} desc`,
    ),
    index("idx_audit_logs_resource").on(
      table.instanceId,
      table.resourceType,
      table.resourceId,
      sql`${table.createdAt} desc`,
    ),
    index("idx_audit_logs_action").on(
      table.instanceId,
      table.action,
      sql`${table.createdAt} desc`,
    ),
    index("idx_audit_logs_identity_created")
      .on(table.actorUserId, sql`${table.createdAt} desc`)
      .where(sql`${table.scopeType} = 'identity'`),
    check("ck_audit_logs_actor_type", sql`${table.actorType} in ('user', 'customer', 'system')`),
    check("ck_audit_logs_scope_type", sql`${table.scopeType} in ('identity', 'instance')`),
    check(
      "ck_audit_logs_scope",
      sql`(${table.scopeType} = 'identity'
          and ${table.instanceId} is null
          and ${table.actorType} = 'user'
          and ${table.actorUserId} is not null)
        or (${table.scopeType} = 'instance' and ${table.instanceId} is not null)`,
    ),
    check("ck_audit_logs_details_json", sql`json_valid(${table.detailsRedactedJson})`),
    check(
      "ck_audit_logs_actor",
      sql`(${table.actorType} = 'user'
          and ${table.actorUserId} is not null
          and ${table.actorCustomerId} is null)
        or (${table.actorType} = 'customer'
          and ${table.actorCustomerId} is not null
          and ${table.actorUserId} is null)
        or (${table.actorType} = 'system'
          and ${table.actorUserId} is null
          and ${table.actorCustomerId} is null)`,
    ),
  ],
);
