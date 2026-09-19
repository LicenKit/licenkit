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

    expect(names).toHaveLength(26);
    expect(names).toContain("license_plans");
    expect(names).toContain("activations");
    expect(names).toContain("billing_checkout_verifications");
    expect(names).not.toContain("policies");
    expect(names).not.toContain("machines");
    expect(names).not.toContain("webhook_events");
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
         id, instance_name, app_url, initialized_at, updated_at
       ) VALUES ('current', 'LicenKit', 'https://example.com', ?, ?)`,
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
