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

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function seedOwner(db: Database.Database): void {
  db.prepare(
    `INSERT INTO instances (id, name, slug, site_url, status, created_at, updated_at)
     VALUES ('ins_a', 'Instance A', 'a', 'https://a.example.test', 'active', ?, ?)`,
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

describe("User and Instance initial database schema", () => {
  it("contains exactly one executable initial migration", () => {
    expect(fs.readdirSync(drizzleDir).filter((file) => file.endsWith(".sql")).sort())
      .toEqual(["0000_v1_initial.sql"]);
    const db = createDb();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toHaveLength(29);
    expect(tables).toEqual(expect.arrayContaining([
      "users", "instances", "instance_memberships", "instance_invitations",
      "deployment_bootstrap", "admin_sessions",
    ]));
    expect(tables).not.toEqual(expect.arrayContaining(["accounts", "system_settings"]));
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
      `INSERT INTO instances (id, name, slug, site_url, status, created_at, updated_at)
       VALUES ('ins_b', 'Instance B', 'b', 'https://b.example.test', 'active', ?, ?)`,
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
         (id, instance_id, slug, name, billing_environment, status, created_at, updated_at)
       VALUES ('prd_a', 'ins_a', 'app', 'App', 'sandbox', 'active', ?, ?)`,
    ).run(now, now);
    expect(db.prepare("SELECT payment_grace_seconds FROM products WHERE id = 'prd_a'").get())
      .toEqual({ payment_grace_seconds: 0 });
    expect(() => db.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         signed_token_ttl_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES ('pln_bad', 'ins_a', 'prd_a', 'Bad', 'subscription', 'opaque',
         0, 60, 1, '[]', 'active', ?, ?)`,
    ).run(now, now)).toThrow(/LICENSE_PLAN_PAYMENT_GRACE_MISMATCH/);
    db.prepare("UPDATE products SET payment_grace_seconds = 60 WHERE id = 'prd_a'").run();
    db.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         signed_token_ttl_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES ('pln_ok', 'ins_a', 'prd_a', 'OK', 'subscription', 'opaque',
         0, 60, 1, '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare("UPDATE products SET payment_grace_seconds = 120 WHERE id = 'prd_a'").run();
    expect(db.prepare("SELECT payment_grace_seconds FROM license_plans WHERE id = 'pln_ok'").get())
      .toEqual({ payment_grace_seconds: 60 });
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
      "trg_instance_memberships_last_owner_update",
      "trg_instance_memberships_last_owner_delete",
      "trg_instance_memberships_invitation_on_insert",
      "trg_instance_memberships_invitation_on_rejoin",
      "trg_instance_invitations_terminal_guard",
      "trg_customer_login_challenges_terminal_guard",
    ]));
    expect(triggers).toHaveLength(24);
  });
});
