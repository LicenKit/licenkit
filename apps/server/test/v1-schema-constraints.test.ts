import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, createTestEnv } from "./helpers/mock-d1";

const drizzleDir = path.resolve(__dirname, "../drizzle");

function applyInTransactions(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  const migrations = fs.readdirSync(drizzleDir).filter((file) => file.endsWith(".sql")).sort();
  expect(migrations).toEqual([
    "0000_v1_initial.sql",
    "0001_email_delivery_schema.sql",
    "0002_romantic_yellow_claw.sql",
  ]);
  for (const migration of migrations) {
    const statements = fs.readFileSync(path.join(drizzleDir, migration), "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    db.transaction(() => statements.forEach((statement) => db.exec(statement)))();
  }
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function foreignKeyTargets(db: Database.Database, table: string): string[] {
  return (db.pragma(`foreign_key_list(${table})`) as Array<{ table: string }>).map((foreignKey) => foreignKey.table);
}

describe("email Delivery database schema", () => {
  it("applies the initial schema and replacement migration with foreign keys enabled", () => {
    const db = new Database(":memory:");
    applyInTransactions(db);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toContain("email_deliveries");
    expect(tables).toContain("email_integrations");
    expect(tables).toContain("email_template_bindings");
    expect(tables).not.toContain("outbound_endpoints");
    expect(tables).not.toContain("outbound_deliveries");
    expect(tables).not.toContain("outbound_attempts");
    expect(tables).not.toContain("system_issue_inbound_events");
    expect(tables).not.toContain("email_system_issues");
    expect(tables).not.toContain("email_system_issue_deliveries");
  });

  it("keeps one compact email Delivery row instead of request snapshots and Attempt rows", () => {
    const { sqliteDb } = createTestEnv();
    expect(columnNames(sqliteDb, "email_deliveries")).toEqual([
      "id",
      "account_id",
      "customer_id",
      "notification_type",
      "contract_version",
      "recipient_email",
      "variables_ciphertext",
      "send_expires_at",
      "variables_expires_at",
      "status",
      "attempt_count",
      "next_attempt_at",
      "provider_message_id",
      "last_error_json",
      "locked_by",
      "locked_until",
      "accepted_at",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(sqliteDb, "email_deliveries")).not.toEqual(expect.arrayContaining([
      "license_id",
      "request_ciphertext",
      "provider_template_ref",
      "last_http_status",
      "last_error_code",
      "last_response_redacted",
    ]));
  });

  it("keeps Binding as current configuration only", () => {
    const { sqliteDb } = createTestEnv();
    expect(columnNames(sqliteDb, "email_template_bindings")).toEqual([
      "id",
      "account_id",
      "email_integration_id",
      "notification_type",
      "contract_version",
      "provider_template_ref",
      "status",
      "created_at",
      "updated_at",
    ]);

    const now = "2026-09-20T10:00:00.000Z";
    sqliteDb.prepare(
      "INSERT INTO accounts (id, name, slug, status, created_at, updated_at) VALUES ('acc_binding', 'Binding', 'binding', 'active', ?, ?)",
    ).run(now, now);
    sqliteDb.prepare(
      `INSERT INTO email_integrations (
         id, account_id, provider, name, credential_ciphertext,
         default_from_email, max_automatic_attempts, status, created_at, updated_at
       ) VALUES ('emi_binding', 'acc_binding', 'resend', 'Primary', 'ciphertext',
         'sender@example.test', 4, 'active', ?, ?)`,
    ).run(now, now);
    sqliteDb.prepare(
      `INSERT INTO email_template_bindings (
         id, account_id, email_integration_id, notification_type,
         contract_version, provider_template_ref, status, created_at, updated_at
       ) VALUES ('etb_v1', 'acc_binding', 'emi_binding', 'customer.license_issued',
         1, 'template-v1', 'active', ?, ?)`,
    ).run(now, now);
    expect(() => sqliteDb.prepare(
      `INSERT INTO email_template_bindings (
         id, account_id, email_integration_id, notification_type,
         contract_version, provider_template_ref, status, created_at, updated_at
       ) VALUES ('etb_v2', 'acc_binding', 'emi_binding', 'customer.license_issued',
         2, 'template-v2', 'active', ?, ?)`,
    ).run(now, now)).toThrow(/UNIQUE/);
  });

  it("requires account and customer ownership on every email Delivery", () => {
    const { sqliteDb } = createTestEnv();
    const now = "2026-09-20T10:00:00.000Z";
    sqliteDb.prepare(
      "INSERT INTO accounts (id, name, slug, status, created_at, updated_at) VALUES ('acc_a', 'A', 'a', 'active', ?, ?)",
    ).run(now, now);
    sqliteDb.prepare(
      "INSERT INTO accounts (id, name, slug, status, created_at, updated_at) VALUES ('acc_b', 'B', 'b', 'active', ?, ?)",
    ).run(now, now);
    sqliteDb.prepare(
      "INSERT INTO customers (id, account_id, email, status, created_at, updated_at) VALUES ('cus_b', 'acc_b', 'b@example.test', 'active', ?, ?)",
    ).run(now, now);
    expect(() => sqliteDb.prepare(
      `INSERT INTO email_deliveries (
         id, account_id, customer_id, notification_type, contract_version,
         recipient_email, variables_ciphertext,
         status, attempt_count, next_attempt_at, created_at, updated_at
       ) VALUES ('dly_cross', 'acc_a', 'cus_b', 'customer.license_issued', 1,
         'b@example.test', 'ciphertext', 'pending', 0, ?, ?, ?)`,
    ).run(now, now, now)).toThrow(/FOREIGN KEY/);
  });

  it("moves every business delivery reference to email_deliveries", () => {
    const { sqliteDb } = createTestEnv();
    for (const table of [
      "customer_login_challenges",
      "license_key_rotations",
      "billing_checkout_verifications",
    ]) {
      expect(foreignKeyTargets(sqliteDb, table)).toContain("email_deliveries");
      expect(foreignKeyTargets(sqliteDb, table)).not.toContain("outbound_deliveries");
    }
  });

  it("keeps System Issue as a deduplicated error inbox with manual handling state", () => {
    const { sqliteDb } = createTestEnv();
    expect(columnNames(sqliteDb, "system_issues")).toEqual([
      "id",
      "account_id",
      "category",
      "source_type",
      "source_id",
      "operation",
      "error_code",
      "error_detail_json",
      "status",
      "occurrence_count",
      "first_seen_at",
      "last_seen_at",
      "processed_at",
      "processed_by_user_id",
    ]);
    expect(columnNames(sqliteDb, "inbound_events")).not.toContain("blocking_system_issue_id");
  });

  it("enforces status, lock, acceptance, and encrypted-variable invariants", () => {
    const { sqliteDb } = createTestEnv();
    const now = "2026-09-20T10:00:00.000Z";
    sqliteDb.prepare("INSERT INTO accounts (id, name, slug, status, created_at, updated_at) VALUES ('acc_a', 'A', 'a', 'active', ?, ?)").run(now, now);
    sqliteDb.prepare("INSERT INTO customers (id, account_id, email, status, created_at, updated_at) VALUES ('cus_a', 'acc_a', 'a@example.test', 'active', ?, ?)").run(now, now);
    const insert = sqliteDb.prepare(
      `INSERT INTO email_deliveries (
         id, account_id, customer_id, notification_type, contract_version,
         recipient_email, variables_ciphertext, variables_expires_at,
         status, attempt_count, next_attempt_at, provider_message_id,
         last_error_json, locked_by, locked_until, accepted_at, created_at, updated_at
       ) VALUES (?, 'acc_a', 'cus_a', 'customer.license_issued', 1,
         'a@example.test', ?, '2026-09-21T10:00:00.000Z', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() => insert.run("dly_bad_processing", "cipher", "processing", now, null, null, null, null, null, now, now)).toThrow(/ck_email_deliveries_lock/);
    expect(() => insert.run("dly_bad_accepted", "cipher", "accepted", null, null, null, null, null, now, now, now)).toThrow(/ck_email_deliveries_acceptance/);
    expect(() => insert.run("dly_valid_accepted", "cipher", "accepted", null, "message", null, null, null, now, now, now)).not.toThrow();
    expect(() => insert.run("dly_bad_error", "cipher", "failed", null, null, "not-json", null, null, null, now, now)).toThrow(/ck_email_deliveries_last_error_json/);
  });

  it("preserves checkout verification triggers while rebuilding its Delivery foreign key", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(triggers).toEqual(expect.arrayContaining([
      "trg_billing_offers_lock_verified_mapping",
      "trg_checkout_verifications_require_draft_sandbox",
      "trg_checkout_verifications_immutable_identity",
    ]));
  });
});
