import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// 1. 系统配置表 (System Settings - 单行单例 id='current')
export const systemSettings = sqliteTable("system_settings", {
  id: text("id").primaryKey().default("current"),
  instanceName: text("instance_name").notNull(),
  appUrl: text("app_url").notNull(),
  apiBaseUrl: text("api_base_url"),
  allowSignup: integer("allow_signup", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// 2. 租户主体表 (Accounts)
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  customDomain: text("custom_domain").unique(),
  paymentConfigs: text("payment_configs"), // AES-256-GCM encrypted JSON
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_accounts_slug").on(table.slug),
  uniqueIndex("idx_accounts_custom_domain").on(table.customDomain),
]);

// 3. 自然人用户表 (Users)
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull().default("owner"), // 'owner' | 'admin' | 'member' | 'viewer'
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_users_account_id").on(table.accountId),
  uniqueIndex("idx_users_email").on(table.email),
]);

// 4. 产品表 (Products)
export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  trialDays: integer("trial_days").notNull().default(14),
  trialFeatures: text("trial_features").notNull().default("[]"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_products_account_id").on(table.accountId),
]);

// 5. 密钥版本表 (Crypto Keys)
export const cryptoKeys = sqliteTable("crypto_keys", {
  kid: text("kid").primaryKey(),
  accountId: text("account_id").notNull(),
  productId: text("product_id").notNull(),
  algorithm: text("algorithm").notNull().default("Ed25519"),
  source: text("source").notNull().default("platform"), // 'platform' | 'uploaded'
  publicKey: text("public_key").notNull(), // Base64 encoded 32B public key
  keyMaterial: text("key_material").notNull(), // AES-256-GCM ciphertext
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_crypto_keys_account_product").on(table.accountId, table.productId),
]);

// 6. 授权策略表 (Policies)
export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  productId: text("product_id").notNull(),
  name: text("name").notNull(),
  duration: integer("duration"), // seconds, NULL = perpetual
  offlineGracePeriod: integer("offline_grace_period").notNull().default(2592000),
  maxMachines: integer("max_machines").notNull().default(1),
  floating: integer("floating", { mode: "boolean" }).notNull().default(false),
  strict: integer("strict", { mode: "boolean" }).notNull().default(true),
  scheme: text("scheme").notNull().default("ed25519"), // 'ed25519' | 'guid'
  features: text("features").notNull().default("[]"),
  metadata: text("metadata").notNull().default("{}"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_policies_account_id").on(table.accountId),
  index("idx_policies_product_id").on(table.productId),
]);

// 7. 许可证表 (Licenses) - 纯 SHA-256 单向散列架构
export const licenses = sqliteTable("licenses", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  productId: text("product_id").notNull(),
  policyId: text("policy_id").notNull(),
  keyHash: text("key_hash").notNull(),
  customerEmail: text("customer_email"),
  source: text("source").notNull().default("manual"), // 'manual' | 'api' | 'paddle' | 'stripe' | 'lemonsqueezy'
  status: text("status").notNull().default("active"), // 'active' | 'suspended' | 'expired' | 'revoked'
  revokeReason: text("revoke_reason"),
  metadata: text("metadata").notNull().default("{}"),
  expiresAt: text("expires_at"),
  suspendedAt: text("suspended_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_licenses_account_key_hash").on(table.accountId, table.keyHash),
  index("idx_licenses_account_id").on(table.accountId),
  index("idx_licenses_product_policy").on(table.productId, table.policyId),
  index("idx_licenses_customer_email").on(table.customerEmail),
  index("idx_licenses_status").on(table.status),
  index("idx_licenses_source_status").on(table.accountId, table.source, table.status),
  index("idx_licenses_created_at").on(table.createdAt),
]);

// 8. 机器硬件席位绑定表 (Machines) - Machine Token 双层凭据
export const machines = sqliteTable("machines", {
  id: text("id").primaryKey(),
  licenseId: text("license_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  tokenHash: text("token_hash").notNull(),
  name: text("name"),
  platform: text("platform"),
  ip: text("ip"),
  lastHeartbeatAt: text("last_heartbeat_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_machines_license_id").on(table.licenseId),
  index("idx_machines_fingerprint").on(table.fingerprint),
  uniqueIndex("idx_machines_license_fingerprint").on(table.licenseId, table.fingerprint),
  index("idx_machines_token_hash").on(table.tokenHash),
]);

// 9. 试用记录表 (Product Trials)
export const productTrials = sqliteTable("product_trials", {
  accountId: text("account_id").notNull(),
  productId: text("product_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  claimedAt: text("claimed_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.productId, table.fingerprint] }),
  index("idx_product_trials_account").on(table.accountId),
]);

// 10. Webhook 出向广播端点表 (Webhook Endpoints)
export const webhookEndpoints = sqliteTable("webhook_endpoints", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  productId: text("product_id").notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  events: text("events").notNull().default("[\"*\"]"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_webhook_endpoints_account").on(table.accountId),
  index("idx_webhook_endpoints_product").on(table.productId),
]);

// 11. 双向 Webhook 事件流水表 (Webhook Events)
export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  provider: text("provider").notNull(), // 'stripe' | 'paddle' | 'lemonsqueezy' | 'custom' | 'internal'
  direction: text("direction").notNull(), // 'inbound' | 'outbound'
  endpointId: text("endpoint_id"),
  eventId: text("event_id"),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("pending"), // 'pending' | 'processed' | 'failed'
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  processedAt: text("processed_at"),
}, (table) => [
  index("idx_webhook_events_account").on(table.accountId),
  index("idx_webhook_events_dir_status").on(table.direction, table.status, table.createdAt),
]);

// 12. 管理员细粒度操作审计流水表 (Audit Logs)
export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  userId: text("user_id").notNull(),
  userEmail: text("user_email").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  details: text("details").notNull().default("{}"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_audit_logs_account_created").on(table.accountId, table.createdAt),
  index("idx_audit_logs_user").on(table.accountId, table.userId, table.createdAt),
  index("idx_audit_logs_action").on(table.accountId, table.action, table.createdAt),
  index("idx_audit_logs_resource").on(table.accountId, table.resourceType, table.resourceId),
]);

