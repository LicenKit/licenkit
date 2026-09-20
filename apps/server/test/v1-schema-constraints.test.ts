import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const drizzleDir = path.resolve(__dirname, "../drizzle");
const now = "2026-09-19T00:00:00Z";

function applyV1Migration(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  const migrations = fs.readdirSync(drizzleDir).filter((file) => file.endsWith(".sql")).sort();
  expect(migrations).toEqual(["0000_v1_initial.sql"]);

  const sql = fs.readFileSync(path.join(drizzleDir, migrations[0]), "utf8");
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    db.exec(statement);
  }
}

function seedAccount(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO accounts (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `Account ${id}`, id.toLowerCase(), now, now);
}

function seedProduct(
  db: Database.Database,
  accountId: string,
  id: string,
  billingEnvironment: "sandbox" | "live" | null = null,
): void {
  db.prepare(
    `INSERT INTO products (
       id, account_id, slug, name, billing_environment, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, accountId, id.toLowerCase(), `Product ${id}`, billingEnvironment, now, now);
}

function seedCustomer(db: Database.Database, accountId: string, id: string): void {
  db.prepare(
    `INSERT INTO customers (id, account_id, email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, accountId, `${id.toLowerCase()}@example.com`, now, now);
}

function seedUser(db: Database.Database, accountId: string, id: string): void {
  db.prepare(
    `INSERT INTO users (
       id, account_id, email, password_hash, name, role, created_at, updated_at
     ) VALUES (?, ?, ?, 'hash', ?, 'owner', ?, ?)`,
  ).run(id, accountId, `${id.toLowerCase()}@example.com`, `User ${id}`, now, now);
}

function seedBillingProvider(
  db: Database.Database,
  accountId: string,
  id: string,
  environment: "sandbox" | "live" = "sandbox",
): void {
  const token = environment === "sandbox" ? "test_public" : "live_public";
  db.prepare(
    `INSERT INTO billing_providers (
       id, account_id, provider, environment, client_side_token,
       webhook_secret_ciphertext, created_at, updated_at
     ) VALUES (?, ?, 'paddle', ?, ?, 'ciphertext', ?, ?)`,
  ).run(id, accountId, environment, token, now, now);
}

function seedSystemIssue(
  db: Database.Database,
  accountId: string,
  providerId: string,
  id: string,
  issueCode = "BILLING_PROVIDER_API_AUTH_INVALID",
): void {
  db.prepare(
    `INSERT INTO system_issues (
       id, account_id, billing_provider_id, capability, issue_code,
       first_seen_at, last_seen_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'customer_read', ?, ?, ?, ?, ?)`,
  ).run(id, accountId, providerId, issueCode, now, now, now, now);
}

function seedInboundEvent(
  db: Database.Database,
  accountId: string,
  providerId: string,
  id: string,
  blockingSystemIssueId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO inbound_events (
       id, account_id, billing_provider_id, external_event_id,
       external_event_type, payload_hash, payload_expires_at,
       blocking_system_issue_id, received_at, updated_at
     ) VALUES (?, ?, ?, ?, 'transaction.completed', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    accountId,
    providerId,
    `external-${id}`,
    `hash-${id}`,
    "2026-09-20T00:00:00Z",
    blockingSystemIssueId,
    now,
    now,
  );
}

function seedPerpetualPlan(
  db: Database.Database,
  accountId: string,
  productId: string,
  id: string,
): void {
  db.prepare(
    `INSERT INTO license_plans (
       id, account_id, product_id, name, license_model, credential_mode,
       payment_grace_seconds, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'perpetual', 'opaque', 0, ?, ?)`,
  ).run(id, accountId, productId, `Plan ${id}`, now, now);
}

interface LicenseSeed {
  id: string;
  accountId: string;
  customerId: string;
  productId: string;
  planId: string;
  keyHash: string;
  source?: "manual" | "payment";
  providerId?: string;
  transactionId?: string;
  checkoutVerification?: boolean;
}

function seedPerpetualLicense(db: Database.Database, seed: LicenseSeed): void {
  const source = seed.source ?? "manual";
  const checkoutVerification = seed.checkoutVerification ? 1 : 0;
  const status = seed.checkoutVerification ? "suspended" : "active";
  const statusReason = seed.checkoutVerification ? "checkout_verification" : null;

  db.prepare(
    `INSERT INTO licenses (
       id, account_id, customer_id, product_id, plan_id, plan_revision,
       license_model, renewal_mode, credential_mode, signed_token_ttl_seconds,
       payment_grace_seconds, max_activations, key_hash, source,
       source_billing_provider_id, source_external_transaction_id,
       is_checkout_verification, status, status_reason, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, 1, 'perpetual', 'none', 'opaque', 0,
       0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    seed.id,
    seed.accountId,
    seed.customerId,
    seed.productId,
    seed.planId,
    seed.keyHash,
    source,
    seed.providerId ?? null,
    seed.transactionId ?? null,
    checkoutVerification,
    status,
    statusReason,
    now,
    now,
  );
}

describe("V1 initial database schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyV1Migration(db);
  });

  afterEach(() => db.close());

  it("builds the complete V1 baseline without legacy tables", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const names = tables.map(({ name }) => name);

    expect(names).toHaveLength(28);
    expect(names).toContain("license_plans");
    expect(names).toContain("activations");
    expect(names).toContain("billing_checkout_verifications");
    expect(names).toContain("system_issues");
    expect(names).toContain("system_issue_inbound_events");
    expect(names).not.toContain("policies");
    expect(names).not.toContain("machines");
    expect(names).not.toContain("webhook_events");
    expect(names).not.toContain("inbound_event_attempts");
    expect(db.pragma("foreign_key_check")).toEqual([]);

    const triggerCount = db
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'")
      .get() as { count: number };
    expect(triggerCount.count).toBe(15);
  });

  it("defines tenant child references as account-scoped composite foreign keys", () => {
    const tenantTables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT IN ('system_settings', 'accounts')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    for (const { name } of tenantTables) {
      const foreignKeys = db.pragma(`foreign_key_list(${name})`) as Array<{
        id: number;
        table: string;
        from: string;
        to: string;
      }>;
      const groups = new Map<number, typeof foreignKeys>();
      for (const foreignKey of foreignKeys) {
        const group = groups.get(foreignKey.id) ?? [];
        group.push(foreignKey);
        groups.set(foreignKey.id, group);
      }

      for (const group of groups.values()) {
        if (group[0].table === "accounts") continue;
        expect(group.some((part) => part.from === "account_id" && part.to === "account_id")).toBe(
          true,
        );
      }
    }

    seedAccount(db, "acct_a");
    seedAccount(db, "acct_b");
    seedProduct(db, "acct_b", "prod_b");

    expect(() =>
      db
        .prepare(
          `INSERT INTO product_releases (
             id, account_id, product_id, version, platform, artifact_sha256,
             released_at, created_at, updated_at
           ) VALUES ('rel_cross', 'acct_a', 'prod_b', '1.0.0', 'macos', ?, ?, ?, ?)`,
        )
        .run("a".repeat(64), now, now, now),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("enforces case-insensitive tenant identities and key uniqueness", () => {
    seedAccount(db, "acct_a");
    seedCustomer(db, "acct_a", "cust_a");

    expect(() =>
      db
        .prepare(
          `INSERT INTO customers (id, account_id, email, created_at, updated_at)
           VALUES ('cust_duplicate', 'acct_a', 'CUST_A@EXAMPLE.COM', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/UNIQUE constraint failed/);

    seedProduct(db, "acct_a", "prod_a");
    expect(() => seedProduct(db, "acct_a", "PROD_A")).toThrow(/UNIQUE constraint failed/);
  });

  it("locks setup and immutable Product Release facts", () => {
    db.prepare(
      `INSERT INTO system_settings (
         id, instance_name, app_url, site_url, initialized_at, updated_at
       ) VALUES ('current', 'LicenKit', 'https://example.com', 'https://example.com', ?, ?)`,
    ).run(now, now);
    expect(() => db.prepare("DELETE FROM system_settings").run()).toThrow(
      /SYSTEM_SETUP_STATE_DELETE_FORBIDDEN/,
    );

    seedAccount(db, "acct_a");
    seedProduct(db, "acct_a", "prod_a");
    db.prepare(
      `INSERT INTO product_releases (
         id, account_id, product_id, version, platform, artifact_sha256,
         released_at, created_at, updated_at
       ) VALUES ('rel_a', 'acct_a', 'prod_a', '1.0.0', 'macos', ?, ?, ?, ?)`,
    ).run("a".repeat(64), now, now, now);

    expect(() =>
      db.prepare("UPDATE product_releases SET version = '1.0.1' WHERE id = 'rel_a'").run(),
    ).toThrow(/PRODUCT_RELEASE_IDENTITY_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM product_releases WHERE id = 'rel_a'").run()).toThrow(
      /PRODUCT_RELEASE_DELETE_FORBIDDEN/,
    );
  });

  it("stores Scheduler health as an all-or-nothing successful run fact", () => {
    const setupUpdatedAt = "2026-09-18T00:00:00Z";
    db.prepare(
      `INSERT INTO system_settings (
         id, instance_name, app_url, site_url, initialized_at, updated_at
       ) VALUES ('current', 'LicenKit', 'https://example.com', 'https://example.com', ?, ?)`,
    ).run(now, setupUpdatedAt);

    expect(() =>
      db
        .prepare(
          `UPDATE system_settings
           SET scheduler_last_success_at = ?, scheduler_last_duration_ms = NULL
           WHERE id = 'current'`,
        )
        .run(now),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          `UPDATE system_settings
           SET scheduler_last_success_at = ?, scheduler_last_duration_ms = -1
           WHERE id = 'current'`,
        )
        .run(now),
    ).toThrow(/CHECK constraint failed/);

    db.prepare(
      `UPDATE system_settings
       SET scheduler_last_success_at = ?, scheduler_last_duration_ms = 42
       WHERE id = 'current'`,
    ).run(now);
    expect(
      db
        .prepare(
          `SELECT scheduler_last_success_at AS successAt,
                  scheduler_last_duration_ms AS durationMs,
                  updated_at AS updatedAt
           FROM system_settings WHERE id = 'current'`,
        )
        .get(),
    ).toEqual({ successAt: now, durationMs: 42, updatedAt: setupUpdatedAt });
  });

  it("enforces System Issue identity, tenant and resolution invariants", () => {
    seedAccount(db, "acct_a");
    seedAccount(db, "acct_b");
    seedUser(db, "acct_a", "user_a");
    seedUser(db, "acct_b", "user_b");
    seedBillingProvider(db, "acct_a", "provider_a");
    seedBillingProvider(db, "acct_b", "provider_b");
    seedSystemIssue(db, "acct_a", "provider_a", "issue_a");

    expect(() =>
      seedSystemIssue(db, "acct_a", "provider_a", "issue_duplicate"),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      seedSystemIssue(db, "acct_a", "provider_b", "issue_cross", "PROVIDER_CROSS_ACCOUNT"),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO system_issues (
             id, account_id, billing_provider_id, capability, issue_code,
             first_seen_at, last_seen_at, last_error_detail_json,
             created_at, updated_at
           ) VALUES ('issue_bad_json', 'acct_a', 'provider_a',
             'customer_portal_session', 'BAD_JSON', ?, ?, '[]', ?, ?)`,
        )
        .run(now, now, now, now),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          `UPDATE system_issues
           SET status = 'resolved', resolved_at = ?,
               resolved_by_user_id = 'user_b', resolution_note = 'fixed'
           WHERE id = 'issue_a'`,
        )
        .run(now),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db
        .prepare(
          `UPDATE system_issues
           SET status = 'resolved', resolved_at = ?,
               resolved_by_user_id = 'user_a', resolution_note = '   '
           WHERE id = 'issue_a'`,
        )
        .run(now),
    ).toThrow(/CHECK constraint failed/);

    db.prepare(
      `UPDATE system_issues
       SET status = 'resolved', resolved_at = ?,
           resolved_by_user_id = 'user_a', resolution_note = 'credential replaced'
       WHERE id = 'issue_a'`,
    ).run(now);
  });

  it("keeps current Inbound blocking and permanent issue history separate", () => {
    seedAccount(db, "acct_a");
    seedAccount(db, "acct_b");
    seedBillingProvider(db, "acct_a", "provider_a");
    seedBillingProvider(db, "acct_b", "provider_b");
    seedSystemIssue(db, "acct_a", "provider_a", "issue_a");

    expect(() =>
      seedInboundEvent(db, "acct_b", "provider_b", "event_cross", "issue_a"),
    ).toThrow(/FOREIGN KEY constraint failed/);

    seedInboundEvent(db, "acct_a", "provider_a", "event_a", "issue_a");
    seedInboundEvent(db, "acct_b", "provider_b", "event_b");
    db.prepare(
      `INSERT INTO system_issue_inbound_events (
         account_id, system_issue_id, inbound_event_id, first_seen_at, last_seen_at
       ) VALUES ('acct_a', 'issue_a', 'event_a', ?, ?)`,
    ).run(now, now);

    expect(() =>
      db
        .prepare(
          `INSERT INTO system_issue_inbound_events (
             account_id, system_issue_id, inbound_event_id, first_seen_at, last_seen_at
           ) VALUES ('acct_a', 'issue_a', 'event_a', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO system_issue_inbound_events (
             account_id, system_issue_id, inbound_event_id, first_seen_at, last_seen_at
           ) VALUES ('acct_a', 'issue_a', 'event_b', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare(
      `UPDATE inbound_events
       SET blocking_system_issue_id = NULL
       WHERE account_id = 'acct_a' AND id = 'event_a'`,
    ).run();
    expect(
      db
        .prepare(
          `SELECT count(*) AS count FROM system_issue_inbound_events
           WHERE account_id = 'acct_a'
             AND system_issue_id = 'issue_a'
             AND inbound_event_id = 'event_a'`,
        )
        .get(),
    ).toEqual({ count: 1 });

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'idx_inbound_events_blocking_issue',
           'idx_system_issue_inbound_events_issue',
           'idx_system_issue_inbound_events_event'
         ) ORDER BY name`,
      )
      .all();
    expect(indexes).toHaveLength(3);
  });

  it("enforces the activation seat limit on insertion and reactivation", () => {
    seedAccount(db, "acct_a");
    seedCustomer(db, "acct_a", "cust_a");
    seedProduct(db, "acct_a", "prod_a");
    seedPerpetualPlan(db, "acct_a", "prod_a", "plan_a");
    seedPerpetualLicense(db, {
      id: "lic_a",
      accountId: "acct_a",
      customerId: "cust_a",
      productId: "prod_a",
      planId: "plan_a",
      keyHash: "key-a",
    });

    const insertActivation = db.prepare(
      `INSERT INTO activations (
         id, account_id, license_id, fingerprint_hash, machine_token_hash,
         status, activated_at, updated_at
       ) VALUES (?, 'acct_a', 'lic_a', ?, ?, 'active', ?, ?)`,
    );
    insertActivation.run("act_a", "fingerprint-a", "machine-a", now, now);

    expect(() =>
      insertActivation.run("act_b", "fingerprint-b", "machine-b", now, now),
    ).toThrow(/LICENSE_ACTIVATION_LIMIT_REACHED/);

    db.prepare("UPDATE activations SET status = 'deactivated' WHERE id = 'act_a'").run();
    insertActivation.run("act_b", "fingerprint-b", "machine-b", now, now);
    expect(() =>
      db.prepare("UPDATE activations SET status = 'active' WHERE id = 'act_a'").run(),
    ).toThrow(/LICENSE_ACTIVATION_LIMIT_REACHED/);
  });

  it("keeps payment and Checkout verification environment boundaries fail-closed", () => {
    seedAccount(db, "acct_a");
    seedUser(db, "acct_a", "user_a");
    seedCustomer(db, "acct_a", "cust_a");
    seedProduct(db, "acct_a", "prod_a", "live");
    seedPerpetualPlan(db, "acct_a", "prod_a", "plan_a");

    db.prepare(
      `INSERT INTO billing_providers (
         id, account_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, created_at, updated_at
       ) VALUES ('provider_sandbox', 'acct_a', 'paddle', 'sandbox',
         'test_public', 'ciphertext', ?, ?)`,
    ).run(now, now);

    expect(() =>
      db
        .prepare(
          `INSERT INTO billing_offers (
             id, account_id, billing_provider_id, external_price_id,
             product_id, license_plan_id, purchase_type, status, created_at, updated_at
           ) VALUES ('offer_active', 'acct_a', 'provider_sandbox', 'pri_active',
             'prod_a', 'plan_a', 'one_time', 'active', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/billing_offer_environment_mismatch/);

    db.prepare(
      `INSERT INTO billing_offers (
         id, account_id, billing_provider_id, external_price_id,
         product_id, license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('offer_draft', 'acct_a', 'provider_sandbox', 'pri_draft',
         'prod_a', 'plan_a', 'one_time', 'draft', ?, ?)`,
    ).run(now, now);

    db.prepare(
      `INSERT INTO billing_checkout_verifications (
         id, account_id, billing_offer_id, requested_by_user_id, token_hash,
         expires_at, created_at, updated_at
       ) VALUES ('verify_a', 'acct_a', 'offer_draft', 'user_a', 'verify-hash',
         '2026-09-19T01:00:00Z', ?, ?)`,
    ).run(now, now);
    expect(() =>
      db
        .prepare(
          `UPDATE billing_checkout_verifications
           SET expires_at = '2026-09-19T02:00:00Z' WHERE id = 'verify_a'`,
        )
        .run(),
    ).toThrow(/checkout_verification_identity_immutable/);

    expect(() =>
      seedPerpetualLicense(db, {
        id: "lic_payment",
        accountId: "acct_a",
        customerId: "cust_a",
        productId: "prod_a",
        planId: "plan_a",
        keyHash: "key-payment",
        source: "payment",
        providerId: "provider_sandbox",
        transactionId: "txn_payment",
      }),
    ).toThrow(/payment_license_environment_mismatch/);

    seedPerpetualLicense(db, {
      id: "lic_verify",
      accountId: "acct_a",
      customerId: "cust_a",
      productId: "prod_a",
      planId: "plan_a",
      keyHash: "key-verify",
      source: "payment",
      providerId: "provider_sandbox",
      transactionId: "txn_verify",
      checkoutVerification: true,
    });
    expect(() =>
      db.prepare("UPDATE licenses SET is_checkout_verification = 0 WHERE id = 'lic_verify'").run(),
    ).toThrow(/checkout_verification_flag_immutable/);
  });
});
