import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./helpers/mock-d1";

const drizzleDir = path.resolve(__dirname, "../drizzle");
const now = "2026-09-21T08:00:00.000Z";
const future = "2099-09-21T08:00:00.000Z";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return db;
}

function applyMigrationFile(db: Database.Database, file: string): void {
  const rawSql = fs.readFileSync(path.join(drizzleDir, file), "utf-8");
  for (const statement of rawSql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
    db.exec(statement);
  }
}

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function seedOwner(db: Database.Database): void {
  db.prepare(
    `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
     VALUES ('ins_a', 'Instance A', 'https://a.example.test', 'https://license-a.example.test', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
     VALUES ('usr_owner', 'owner@example.test', 'hash', 'Owner', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO instance_memberships
       (instance_id, user_id, role, status, joined_by_invitation_id, created_at, updated_at)
     VALUES ('ins_a', 'usr_owner', 'owner', 'active', NULL, ?, ?)`,
  ).run(now, now);
  db.prepare(
    "INSERT INTO deployment_bootstrap (singleton_key, completed_at) VALUES ('deployment', ?)",
  ).run(now);
}

function insertDelivery(
  db: Database.Database,
  id: string,
  recipientType: "customer" | "instance_invitation",
  email: string,
  customerId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO email_deliveries (
       id, instance_id, recipient_type, customer_id, notification_type, contract_version,
       recipient_email, variables_ciphertext, send_expires_at, status, attempt_count,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, 'ins_a', ?, ?, ?, 1, ?, 'ciphertext', ?,
       'waiting_configuration', 0, ?, ?, ?)`,
  ).run(
    id,
    recipientType,
    customerId,
    recipientType === "customer" ? "customer.magic_link" : "instance.member_invited",
    email,
    future,
    now,
    now,
    now,
  );
}

describe("User and Instance database schema", () => {
  it("backfills existing payment License environments and permits both Offers on one Product", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const file of [
      "0000_v1_initial.sql", "0001_webhook_verification_evidence.sql",
      "0002_paddle_simulator_verification.sql", "0003_split_release_platform_arch.sql",
      "0004_client_validation_policy.sql", "0005_single_paddle_webhook.sql",
    ]) applyMigrationFile(db, file);
    seedOwner(db);
    db.prepare(`INSERT INTO products
      (id, instance_id, name, billing_environment, status, created_at, updated_at)
      VALUES ('prd_env', 'ins_a', 'App', 'live', 'active', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO license_plans
      (id, instance_id, product_id, name, license_model, credential_mode,
       payment_grace_seconds, features_json, status, created_at, updated_at)
      VALUES ('pln_env', 'ins_a', 'prd_env', 'Plan', 'perpetual', 'opaque',
       0, '[]', 'active', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO products
      (id, instance_id, name, billing_environment, status, created_at, updated_at)
      VALUES ('prd_old_sandbox', 'ins_a', 'Old Test App', 'sandbox', 'active', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO license_plans
      (id, instance_id, product_id, name, license_model, credential_mode,
       payment_grace_seconds, features_json, status, created_at, updated_at)
      VALUES ('pln_old_sandbox', 'ins_a', 'prd_old_sandbox', 'Plan', 'perpetual', 'opaque',
       0, '[]', 'active', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO customers
      (id, instance_id, email, status, created_at, updated_at)
      VALUES ('cus_env', 'ins_a', 'buyer@example.test', 'active', ?, ?)`).run(now, now);
    for (const [id, environment, token] of [
      ["bpr_live", "live", "live_env_token"], ["bpr_sandbox", "sandbox", "test_env_token"],
    ]) {
      db.prepare(`INSERT INTO billing_providers
        (id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at)
        VALUES (?, 'ins_a', 'paddle', ?, ?, 'ciphertext', 'active', ?, ?)`)
        .run(id, environment, token, now, now);
    }
    const insertLicense = db.prepare(`INSERT INTO licenses
      (id, instance_id, customer_id, product_id, plan_id, plan_revision,
       license_model, renewal_mode, credential_mode, offline_grace_seconds,
       payment_grace_seconds, max_activations, features_json, key_hash,
       source, source_billing_provider_id, source_external_transaction_id,
       is_checkout_verification, status, status_reason, created_at, updated_at)
      VALUES (?, 'ins_a', 'cus_env', 'prd_env', 'pln_env', 1,
       'perpetual', 'none', 'opaque', 2592000, 0, 1, '[]', ?,
       'payment', ?, ?, ?, ?, ?, ?, ?)`);
    insertLicense.run("lic_live", "live_hash", "bpr_live", "txn_live", 0, "active", null, now, now);
    insertLicense.run("lic_sandbox_verification", "sandbox_hash", "bpr_sandbox", "txn_sandbox", 1,
      "suspended", "checkout_verification", now, now);
    db.prepare(`INSERT INTO licenses
      (id, instance_id, customer_id, product_id, plan_id, plan_revision,
       license_model, renewal_mode, credential_mode, offline_grace_seconds,
       payment_grace_seconds, max_activations, features_json, key_hash,
       source, status, created_at, updated_at)
      VALUES ('lic_old_sandbox_manual', 'ins_a', 'cus_env', 'prd_old_sandbox', 'pln_old_sandbox', 1,
       'perpetual', 'none', 'opaque', 2592000, 0, 1, '[]', 'old_sandbox_manual_hash',
       'manual', 'active', ?, ?)`).run(now, now);

    db.transaction(() => applyMigrationFile(db, "0006_license_billing_environment.sql"))();
    expect(db.prepare(`SELECT id, billing_environment FROM licenses ORDER BY id`).all()).toEqual([
      { id: "lic_live", billing_environment: "live" },
      { id: "lic_old_sandbox_manual", billing_environment: "sandbox" },
      { id: "lic_sandbox_verification", billing_environment: "sandbox" },
    ]);
    expect(columns(db, "products")).not.toContain("billing_environment");
    expect(() => db.prepare(
      "UPDATE licenses SET billing_environment = 'sandbox' WHERE id = 'lic_live'",
    ).run()).toThrow(/license_billing_environment_immutable/);
    expect(() => db.prepare(
      "UPDATE licenses SET source_billing_provider_id = 'bpr_sandbox' WHERE id = 'lic_live'",
    ).run()).toThrow(/payment_license_environment_mismatch/);
    expect(() => db.prepare(`INSERT INTO licenses
      (id, instance_id, customer_id, product_id, plan_id, plan_revision,
       license_model, renewal_mode, credential_mode, offline_grace_seconds,
       payment_grace_seconds, max_activations, features_json, key_hash,
       source, billing_environment, source_billing_provider_id,
       source_external_transaction_id, status, created_at, updated_at)
      VALUES ('lic_mismatched', 'ins_a', 'cus_env', 'prd_env', 'pln_env', 1,
       'perpetual', 'none', 'opaque', 2592000, 0, 1, '[]', 'mismatched_hash',
       'payment', 'live', 'bpr_sandbox', 'txn_mismatched', 'active', ?, ?)`)
      .run(now, now)).toThrow(/payment_license_environment_mismatch/);
    for (const [id, providerId, priceId] of [
      ["off_live", "bpr_live", "pri_live"], ["off_sandbox", "bpr_sandbox", "pri_sandbox"],
    ]) {
      db.prepare(`INSERT INTO billing_offers
        (id, instance_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at)
        VALUES (?, 'ins_a', ?, ?, 'prd_env', 'pln_env', 'one_time', 'active', ?, ?)`)
        .run(id, providerId, priceId, now, now);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM billing_offers WHERE product_id = 'prd_env' AND status = 'active'").get())
      .toEqual({ count: 2 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("contains the initial schema and forward webhook verification migration", () => {
    expect(fs.readdirSync(drizzleDir).filter((file) => file.endsWith(".sql")).sort())
      .toEqual([
        "0000_v1_initial.sql",
        "0001_webhook_verification_evidence.sql",
        "0002_paddle_simulator_verification.sql",
        "0003_split_release_platform_arch.sql",
        "0004_client_validation_policy.sql",
        "0005_single_paddle_webhook.sql",
        "0006_license_billing_environment.sql",
        "0007_remove_device_tokens.sql",
        "0008_webhook_rejections.sql",
      ]);
    const db = createDb();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toHaveLength(31);
    expect(tables).toEqual(expect.arrayContaining([
      "users", "instances", "instance_memberships", "instance_invitations",
      "deployment_bootstrap", "admin_sessions",
    ]));
    expect(tables).not.toEqual(expect.arrayContaining(["accounts", "system_settings"]));
  });

  it("migrates an existing billing provider without recreating the database", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrationFile(db, "0000_v1_initial.sql");
    db.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES ('ins_existing', 'Existing', 'https://site.example.test',
         'https://admin.example.test', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO billing_providers (
         id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES ('bpr_existing', 'ins_existing', 'paddle', 'sandbox',
         'test_existing_token', 'ciphertext', 'active', ?, ?)`,
    ).run(now, now);

    applyMigrationFile(db, "0001_webhook_verification_evidence.sql");
    applyMigrationFile(db, "0002_paddle_simulator_verification.sql");

    expect(db.prepare(
      `SELECT id, webhook_secret_version, simulator_webhook_secret_ciphertext,
              simulator_webhook_secret_version
       FROM billing_providers WHERE id = 'bpr_existing'`,
    ).get()).toEqual({
      id: "bpr_existing",
      webhook_secret_version: 1,
      simulator_webhook_secret_ciphertext: null,
      simulator_webhook_secret_version: 1,
    });
    expect(columns(db, "inbound_events")).toContain("webhook_secret_version");
    expect(columns(db, "billing_webhook_simulation_tests")).toContain("event_type");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("retires the second Paddle secret and invalidates old Simulator evidence", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const file of [
      "0000_v1_initial.sql",
      "0001_webhook_verification_evidence.sql",
      "0002_paddle_simulator_verification.sql",
      "0003_split_release_platform_arch.sql",
      "0004_client_validation_policy.sql",
    ]) applyMigrationFile(db, file);
    db.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES ('ins_merge', 'Merge', 'https://site.example.test',
         'https://admin.example.test', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO billing_providers (
         id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, simulator_webhook_secret_ciphertext,
         status, created_at, updated_at
       ) VALUES ('bpr_merge', 'ins_merge', 'paddle', 'sandbox',
         'test_merge_token', 'platform_ciphertext', 'simulation_ciphertext',
         'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO billing_webhook_simulation_tests (
         id, instance_id, billing_provider_id, event_type,
         simulator_webhook_secret_version, external_event_id,
         payload_hash, verified_at, created_at, updated_at
       ) VALUES ('bwt_merge', 'ins_merge', 'bpr_merge', 'customer.created',
         1, 'ntfsimevt_old', 'hash', ?, ?, ?)`,
    ).run(now, now, now);

    applyMigrationFile(db, "0005_single_paddle_webhook.sql");
    expect(db.prepare(
      `SELECT webhook_secret_ciphertext, simulator_webhook_secret_ciphertext,
              simulator_webhook_secret_version
       FROM billing_providers WHERE id = 'bpr_merge'`,
    ).get()).toEqual({
      webhook_secret_ciphertext: "platform_ciphertext",
      simulator_webhook_secret_ciphertext: null,
      simulator_webhook_secret_version: 2,
    });
    expect(db.prepare(
      `SELECT simulator_webhook_secret_version FROM billing_webhook_simulation_tests
       WHERE id = 'bwt_merge'`,
    ).get()).toEqual({ simulator_webhook_secret_version: 1 });
  });

  it("splits legacy Product Release platform values without losing existing rows", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrationFile(db, "0000_v1_initial.sql");
    db.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES ('ins_release', 'Release Instance', 'https://site.example.test',
         'https://admin.example.test', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO products (id, instance_id, name, status, created_at, updated_at)
       VALUES ('prd_release', 'ins_release', 'Release Product', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO product_releases (
         id, instance_id, product_id, version, platform, artifact_sha256,
         released_at, created_at, updated_at
       ) VALUES ('rel_existing', 'ins_release', 'prd_release', '1.2.3',
         'macos-arm64', ?, ?, ?, ?)`,
    ).run("a".repeat(64), now, now, now);

    applyMigrationFile(db, "0003_split_release_platform_arch.sql");

    expect(db.prepare(
      `SELECT id, version, platform, arch, released_at
       FROM product_releases WHERE id = 'rel_existing'`,
    ).get()).toEqual({
      id: "rel_existing",
      version: "1.2.3",
      platform: "macos",
      arch: "arm64",
      released_at: now,
    });
    expect(() => db.prepare(
      `INSERT INTO product_releases (
         id, instance_id, product_id, version, platform, artifact_sha256,
         released_at, created_at, updated_at
       ) VALUES ('rel_missing_arch', 'ins_release', 'prd_release', '2.0.0',
         'macos', ?, ?, ?, ?)`,
    ).run("b".repeat(64), now, now, now)).toThrow(/arch/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("migrates the existing Plan TTL column into the shared offline grace snapshot", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const file of [
      "0000_v1_initial.sql",
      "0001_webhook_verification_evidence.sql",
      "0002_paddle_simulator_verification.sql",
      "0003_split_release_platform_arch.sql",
    ]) applyMigrationFile(db, file);

    db.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES ('ins_policy', 'Policy Instance', 'https://site.example.test',
         'https://admin.example.test', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO products (id, instance_id, name, status, created_at, updated_at)
       VALUES ('prd_policy', 'ins_policy', 'Policy Product', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO signing_keys (
         id, instance_id, product_id, source, public_key, private_key_ciphertext,
         status, created_at
       ) VALUES ('key_policy', 'ins_policy', 'prd_policy', 'generated',
         'public-key', 'encrypted-private-key', 'active', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO customers (id, instance_id, email, status, created_at, updated_at)
       VALUES ('cus_policy', 'ins_policy', 'policy@example.test', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         signed_token_ttl_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES (?, 'ins_policy', 'prd_policy', ?, 'perpetual', ?, ?, 0, 1, '[]', 'active', ?, ?)`,
    ).run("pln_signed", "Signed", "signed", 86_400, now, now);
    db.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         signed_token_ttl_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES (?, 'ins_policy', 'prd_policy', ?, 'perpetual', ?, ?, 0, 1, '[]', 'active', ?, ?)`,
    ).run("pln_opaque", "Opaque", "opaque", 0, now, now);
    for (const [id, planID, mode, ttl] of [
      ["lic_signed", "pln_signed", "signed", 86_400],
      ["lic_opaque", "pln_opaque", "opaque", 0],
    ] as const) {
      db.prepare(
        `INSERT INTO licenses (
           id, instance_id, customer_id, product_id, plan_id, plan_revision,
           license_model, renewal_mode, credential_mode, signed_token_ttl_seconds,
           payment_grace_seconds, max_activations, features_json, key_hash,
           source, status, created_at, updated_at
         ) VALUES (?, 'ins_policy', 'cus_policy', 'prd_policy', ?, 1,
           'perpetual', 'none', ?, ?, 0, 1, '[]', ?, 'manual', 'active', ?, ?)`,
      ).run(id, planID, mode, ttl, `hash_${id}`, now, now);
    }

    db.transaction(() => applyMigrationFile(db, "0004_client_validation_policy.sql"))();

    expect(db.prepare(
      "SELECT id, offline_grace_seconds FROM license_plans ORDER BY id",
    ).all()).toEqual([
      { id: "pln_opaque", offline_grace_seconds: 2_592_000 },
      { id: "pln_signed", offline_grace_seconds: 86_400 },
    ]);
    expect(db.prepare(
      "SELECT id, offline_grace_seconds FROM licenses ORDER BY id",
    ).all()).toEqual([
      { id: "lic_opaque", offline_grace_seconds: 2_592_000 },
      { id: "lic_signed", offline_grace_seconds: 86_400 },
    ]);
    expect(db.prepare(
      "SELECT validation_interval_seconds FROM products WHERE id = 'prd_policy'",
    ).get()).toEqual({ validation_interval_seconds: 3_600 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("rolls back migration 0004 if existing rows violate foreign keys", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const file of [
      "0000_v1_initial.sql",
      "0001_webhook_verification_evidence.sql",
      "0002_paddle_simulator_verification.sql",
      "0003_split_release_platform_arch.sql",
    ]) applyMigrationFile(db, file);

    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO admin_sessions (
         id, user_id, session_token_hash, csrf_token_hash, expires_at, created_at
       ) VALUES ('ses_orphan', 'usr_missing', 'token_hash', 'csrf_hash', ?, ?)`,
    ).run(future, now);
    db.pragma("foreign_keys = ON");

    expect(() => db.transaction(() => applyMigrationFile(db, "0004_client_validation_policy.sql"))())
      .toThrow(/ck_migration_fk_guard/);
    expect(columns(db, "license_plans")).toContain("signed_token_ttl_seconds");
    expect(columns(db, "license_plans")).not.toContain("offline_grace_seconds");
    expect(db.prepare("SELECT user_id FROM admin_sessions WHERE id = 'ses_orphan'").get())
      .toEqual({ user_id: "usr_missing" });
  });

  it("keeps User global, Session Instance-free, and the fresh database uninitialized", () => {
    const db = createDb();
    expect(columns(db, "users")).toEqual([
      "id", "email", "password_hash", "name", "created_at", "updated_at",
    ]);
    expect(columns(db, "admin_sessions")).toEqual([
      "id", "user_id", "session_token_hash", "csrf_token_hash", "expires_at",
      "last_seen_at", "revoked_at", "created_at",
    ]);
    expect(columns(db, "instances")).toEqual([
      "id", "name", "site_url", "admin_api_url", "status", "created_at", "updated_at",
    ]);
    expect(columns(db, "products")).toEqual([
      "id", "instance_id", "name", "description",
      "payment_grace_seconds", "validation_interval_seconds", "trial_enabled", "trial_duration_seconds",
      "trial_features_json", "status", "created_at", "updated_at",
    ]);
    for (const table of ["users", "instances", "instance_memberships", "deployment_bootstrap"]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES ('usr_one', 'Owner@Example.test', 'hash', 'Owner', ?, ?)`,
    ).run(now, now);
    expect(() => db.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES ('usr_two', 'owner@example.TEST', 'hash', 'Other', ?, ?)`,
    ).run(now, now)).toThrow(/UNIQUE/);
  });

  it("requires an Invitation for Membership and protects the final active Owner", () => {
    const db = createDb();
    seedOwner(db);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES ('usr_member', 'member@example.test', 'hash', 'Member', ?, ?)`,
    ).run(now, now);
    expect(() => db.prepare(
      `INSERT INTO instance_memberships
         (instance_id, user_id, role, status, joined_by_invitation_id, created_at, updated_at)
       VALUES ('ins_a', 'usr_member', 'member', 'active', NULL, ?, ?)`,
    ).run(now, now)).toThrow(/MEMBERSHIP_INVITATION_REQUIRED/);
    expect(() => db.prepare(
      "UPDATE instance_memberships SET role = 'admin' WHERE instance_id = 'ins_a' AND user_id = 'usr_owner'",
    ).run()).toThrow(/LAST_ACTIVE_OWNER_REQUIRED/);
    expect(() => db.prepare(
      "DELETE FROM instance_memberships WHERE instance_id = 'ins_a' AND user_id = 'usr_owner'",
    ).run()).toThrow(/LAST_ACTIVE_OWNER_REQUIRED/);
  });

  it("accepts an Invitation once and rejects later terminal updates", () => {
    const db = createDb();
    seedOwner(db);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES ('usr_member', 'member@example.test', 'hash', 'Member', ?, ?)`,
    ).run(now, now);
    insertDelivery(db, "dly_invite", "instance_invitation", "member@example.test");
    db.prepare(
      `INSERT INTO instance_invitations (
         id, instance_id, email, role, token_hash, status, invited_by_user_id,
         delivery_id, expires_at, created_at, updated_at
       ) VALUES ('ivi_one', 'ins_a', 'member@example.test', 'member', 'token-hash',
         'pending', 'usr_owner', 'dly_invite', ?, ?, ?)`,
    ).run(future, now, now);
    db.prepare(
      `INSERT INTO instance_memberships
         (instance_id, user_id, role, status, joined_by_invitation_id, created_at, updated_at)
       VALUES ('ins_a', 'usr_member', 'member', 'active', 'ivi_one', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `UPDATE instance_invitations SET status = 'accepted',
         accepted_by_user_id = 'usr_member', accepted_at = ?, updated_at = ?
       WHERE id = 'ivi_one'`,
    ).run(now, now);
    expect(() => db.prepare(
      "UPDATE instance_invitations SET status = 'accepted' WHERE id = 'ivi_one'",
    ).run()).toThrow(/INSTANCE_INVITATION_ALREADY_FINALIZED/);
  });

  it("enforces Delivery recipient type and Customer Challenge terminal consumption", () => {
    const db = createDb();
    seedOwner(db);
    db.prepare(
      `INSERT INTO customers (id, instance_id, email, status, created_at, updated_at)
       VALUES ('cus_a', 'ins_a', 'customer@example.test', 'active', ?, ?)`,
    ).run(now, now);
    insertDelivery(db, "dly_magic", "customer", "customer@example.test", "cus_a");
    insertDelivery(db, "dly_invitation", "instance_invitation", "invitee@example.test");
    expect(() => insertDelivery(
      db, "dly_bad", "instance_invitation", "customer@example.test", "cus_a",
    )).toThrow(/ck_email_deliveries_recipient/);
    db.prepare(
      `INSERT INTO customer_login_challenges
         (id, instance_id, customer_id, token_hash, expires_at, delivery_id, created_at)
       VALUES ('clc_one', 'ins_a', 'cus_a', 'magic-token-hash', ?, 'dly_magic', ?)`,
    ).run(future, now);
    db.prepare("UPDATE customer_login_challenges SET consumed_at = ? WHERE id = 'clc_one'").run(now);
    expect(() => db.prepare(
      "UPDATE customer_login_challenges SET consumed_at = ? WHERE id = 'clc_one'",
    ).run(now)).toThrow(/CUSTOMER_LOGIN_CHALLENGE_NOT_CONSUMABLE/);
  });

  it("enforces cross-Instance foreign keys and audit scope combinations", () => {
    const db = createDb();
    seedOwner(db);
    db.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES ('ins_b', 'Instance B', 'https://b.example.test', 'https://license-b.example.test', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO customers (id, instance_id, email, status, created_at, updated_at)
       VALUES ('cus_b', 'ins_b', 'b@example.test', 'active', ?, ?)`,
    ).run(now, now);
    expect(() => insertDelivery(db, "dly_cross", "customer", "b@example.test", "cus_b"))
      .toThrow(/FOREIGN KEY/);
    db.prepare(
      `INSERT INTO audit_logs
         (id, scope_type, instance_id, actor_type, actor_user_id, action,
          resource_type, details_redacted_json, created_at)
       VALUES ('aud_ok', 'identity', NULL, 'user', 'usr_owner', 'identity.login', 'user', '{}', ?)`,
    ).run(now);
    expect(() => db.prepare(
      `INSERT INTO audit_logs
         (id, scope_type, instance_id, actor_type, actor_user_id, action,
          resource_type, details_redacted_json, created_at)
       VALUES ('aud_bad', 'identity', 'ins_a', 'user', 'usr_owner', 'identity.login', 'user', '{}', ?)`,
    ).run(now)).toThrow(/ck_audit_logs_scope/);
  });

  it("defaults Product grace and enforces the subscription Plan snapshot", () => {
    const db = createDb();
    seedOwner(db);
    db.prepare(
      `INSERT INTO products
         (id, instance_id, name, status, created_at, updated_at)
       VALUES ('prd_a', 'ins_a', 'App', 'active', ?, ?)`,
    ).run(now, now);
    expect(db.prepare("SELECT payment_grace_seconds FROM products WHERE id = 'prd_a'").get())
      .toEqual({ payment_grace_seconds: 0 });
    expect(() => db.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         offline_grace_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES ('pln_bad', 'ins_a', 'prd_a', 'Bad', 'subscription', 'opaque',
         2592000, 60, 1, '[]', 'active', ?, ?)`,
    ).run(now, now)).toThrow(/LICENSE_PLAN_PAYMENT_GRACE_MISMATCH/);
    db.prepare("UPDATE products SET payment_grace_seconds = 60 WHERE id = 'prd_a'").run();
    db.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         offline_grace_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES ('pln_ok', 'ins_a', 'prd_a', 'OK', 'subscription', 'opaque',
         2592000, 60, 1, '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare("UPDATE products SET payment_grace_seconds = 120 WHERE id = 'prd_a'").run();
    expect(db.prepare("SELECT payment_grace_seconds FROM license_plans WHERE id = 'pln_ok'").get())
      .toEqual({ payment_grace_seconds: 60 });
  });

  it("requires one positive offline grace for both credential modes", () => {
    const db = createDb();
    seedOwner(db);
    db.prepare(
      `INSERT INTO products
         (id, instance_id, name, status, created_at, updated_at)
       VALUES ('prd_signed', 'ins_a', 'Signed App', 'active', ?, ?)`,
    ).run(now, now);
    const insertPlan = db.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         offline_grace_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES (?, 'ins_a', 'prd_signed', ?, 'perpetual', 'signed',
         ?, 0, 1, '[]', 'active', ?, ?)`,
    );
    expect(() => insertPlan.run("pln_zero", "Zero", 0, now, now))
      .toThrow(/ck_license_plans_offline_grace/);
    insertPlan.run("pln_positive", "Positive", 1, now, now);
    expect(db.prepare(
      "SELECT offline_grace_seconds FROM license_plans WHERE id = 'pln_positive'",
    ).get()).toEqual({ offline_grace_seconds: 1 });

    const licenseSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'licenses'",
    ).get() as { sql: string };
    expect(licenseSchema.sql).toContain(
      `CHECK("licenses"."offline_grace_seconds" > 0)`,
    );
  });

  it("preserves existing and new custom Triggers", () => {
    const db = createDb();
    const triggers = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(triggers).toEqual(expect.arrayContaining([
      "trg_product_releases_immutable_identity",
      "trg_activations_enforce_limit_on_insert",
      "trg_billing_offers_lock_verified_mapping",
      "trg_checkout_verifications_require_draft_sandbox",
      "trg_licenses_manual_issue_invariant",
      "trg_licenses_billing_environment_immutable",
      "trg_licenses_payment_provider_environment_on_update",
      "trg_instance_memberships_last_owner_update",
      "trg_instance_memberships_last_owner_delete",
      "trg_instance_memberships_invitation_on_insert",
      "trg_instance_memberships_invitation_on_rejoin",
      "trg_instance_invitations_terminal_guard",
      "trg_customer_login_challenges_terminal_guard",
    ]));
    expect(triggers).toHaveLength(23);
  });
});
