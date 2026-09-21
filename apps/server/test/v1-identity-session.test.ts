import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/types";
import { errorHandler } from "../src/middleware/error";
import { setupRouter } from "../src/routes/setup.routes";
import { authRouter } from "../src/routes/auth.routes";
import { customerAuthRouter } from "../src/routes/customer-auth.routes";
import { customerRouter } from "../src/routes/customer.routes";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import {
  ADMIN_ACCOUNT_COOKIE,
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  CUSTOMER_ACCOUNT_COOKIE,
  CUSTOMER_CSRF_COOKIE,
  CUSTOMER_SESSION_COOKIE,
} from "../src/services/identity/session";
import { decryptEnvelopeV1 } from "../src/infra/delivery/crypto";

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${name}=([^;,]+)`));
  if (!match) throw new Error(`Cookie ${name} was not set: ${header}`);
  return match[1];
}

function identityApp() {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.route("/api/v1/setup", setupRouter);
  app.route("/api/v1/admin/auth", authRouter);
  app.route("/api/v1/customer/auth", customerAuthRouter);
  app.route("/api/v1/customer", customerRouter);
  return app;
}

describe("V1 identity and sessions", () => {
  let testEnv: TestEnvContext;

  beforeEach(() => {
    testEnv = createTestEnv({
      INITIAL_SETUP_TOKEN: "initial-setup-token-with-enough-entropy",
      STORAGE_ENCRYPTION_KEY_ID: "test-primary",
      ENVIRONMENT: "test",
      TURNSTILE_SECRET_KEY: "test-turnstile-secret",
      TURNSTILE_SITE_KEY: "test-turnstile-site-key",
    } as any);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      action: "customer_magic_link",
      hostname: "license.example.test",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("rejects an invalid Setup token without leaving partial initialization", async () => {
    const app = identityApp();
    const response = await app.request(
      "https://license.example.test/api/v1/setup",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({
          setupToken: "wrong-token",
          instanceName: "Example Studio",
          siteUrl: "https://license.example.test",
          accountSlug: "example-studio",
          owner: { name: "Owner", email: "owner@example.test", password: "strong-password-123" },
        }),
      },
      testEnv.env
    );
    expect(response.status).toBe(401);
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM system_settings").get()).toEqual({ count: 0 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 0 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });
  });

  it("requires the configured Site URL to share the LicenKit app Origin", async () => {
    const app = identityApp();
    const response = await app.request(
      "https://license.example.test/api/v1/setup",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({
          setupToken: "initial-setup-token-with-enough-entropy",
          instanceName: "Example Studio",
          siteUrl: "https://www.example.test",
          accountSlug: "example-studio",
          owner: { name: "Owner", email: "owner@example.test", password: "strong-password-123" },
        }),
      },
      testEnv.env,
    );

    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe("SETUP_SITE_URL_ORIGIN_MISMATCH");
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM system_settings").get()).toEqual({ count: 0 });
  });

  it("allows exactly one concurrent Setup request to initialize the database", async () => {
    const app = identityApp();
    const request = (suffix: string) => app.request(
      "https://license.example.test/api/v1/setup",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({
          setupToken: "initial-setup-token-with-enough-entropy",
          instanceName: `Concurrent ${suffix}`,
          siteUrl: "https://license.example.test",
          accountSlug: `concurrent-${suffix}`,
          owner: {
            name: `Owner ${suffix}`,
            email: `owner-${suffix}@example.test`,
            password: `strong-password-${suffix}-123`,
          },
        }),
      },
      testEnv.env
    );

    const responses = await Promise.all([request("one"), request("two")]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    expect((await rejected.json() as any).error.code).toBe("SETUP_ALREADY_COMPLETED");
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM system_settings").get()).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get()).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM audit_logs").get()).toEqual({ count: 1 });
  });

  it("atomically initializes once and uses revocable cookie-backed admin sessions", async () => {
    const app = identityApp();
    const setup = await app.request(
      "https://license.example.test/api/v1/setup",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({
          setupToken: "initial-setup-token-with-enough-entropy",
          instanceName: "Example Studio",
          siteUrl: "https://license.example.test/site/",
          accountSlug: "example-studio",
          owner: { name: "Owner", email: "OWNER@example.test", password: "strong-password-123" },
        }),
      },
      testEnv.env
    );
    expect(setup.status).toBe(201);
    expect(setup.headers.get("set-cookie")).toContain(ADMIN_SESSION_COOKIE);
    expect(testEnv.sqliteDb.prepare("SELECT app_url, site_url FROM system_settings").get()).toEqual({
      app_url: "https://license.example.test",
      site_url: "https://license.example.test/site",
    });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });

    const repeated = await app.request(
      "https://license.example.test/api/v1/setup",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({
          setupToken: "initial-setup-token-with-enough-entropy",
          instanceName: "Other",
          siteUrl: "https://license.example.test",
          accountSlug: "other",
          owner: { name: "Other", email: "other@example.test", password: "strong-password-456" },
        }),
      },
      testEnv.env
    );
    expect(repeated.status).toBe(409);
    expect((await repeated.json() as any).error.code).toBe("SETUP_ALREADY_COMPLETED");

    const login = await app.request(
      "https://license.example.test/api/v1/admin/auth/login",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({
          accountSlug: "example-studio",
          email: "owner@example.test",
          password: "strong-password-123",
        }),
      },
      testEnv.env
    );
    expect(login.status).toBe(200);
    const sessionToken = cookieValue(login, ADMIN_SESSION_COOKIE);
    const accountId = cookieValue(login, ADMIN_ACCOUNT_COOKIE);
    const csrfToken = cookieValue(login, ADMIN_CSRF_COOKIE);
    const cookie = `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_ACCOUNT_COOKIE}=${accountId}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`;

    const session = await app.request(
      "https://license.example.test/api/v1/admin/auth/session",
      { headers: { Cookie: cookie } },
      testEnv.env
    );
    expect(session.status).toBe(200);

    const missingCsrf = await app.request(
      "https://license.example.test/api/v1/admin/auth/logout",
      { method: "POST", headers: { Cookie: cookie, Origin: "https://license.example.test" } },
      testEnv.env
    );
    expect(missingCsrf.status).toBe(403);

    const logout = await app.request(
      "https://license.example.test/api/v1/admin/auth/logout",
      {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://license.example.test", "X-CSRF-Token": csrfToken },
      },
      testEnv.env
    );
    expect(logout.status).toBe(200);
    const revoked = await app.request(
      "https://license.example.test/api/v1/admin/auth/session",
      { headers: { Cookie: cookie } },
      testEnv.env
    );
    expect(revoked.status).toBe(401);
  });

  it("does not enumerate unknown emails and consumes a Magic Link only once", async () => {
    const app = identityApp();
    const now = new Date().toISOString();
    const accountId = "acc_identity";
    const customerId = "cus_identity";
    testEnv.sqliteDb.prepare(
      `INSERT INTO system_settings (id, instance_name, app_url, site_url, api_base_url, initialized_at, updated_at)
       VALUES ('current', 'Identity', 'https://license.example.test', 'https://license.example.test/site', 'https://license.example.test/api/v1', ?, ?)`
    ).run(now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO accounts (id, name, slug, status, created_at, updated_at)
       VALUES (?, 'Identity', 'identity', 'active', ?, ?)`
    ).run(accountId, now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO customers (id, account_id, email, name, status, created_at, updated_at)
       VALUES (?, ?, 'buyer@example.test', 'Buyer', 'active', ?, ?)`
    ).run(customerId, accountId, now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO customers (id, account_id, email, name, status, created_at, updated_at)
       VALUES ('cus_other', ?, 'other@example.test', 'Other', 'active', ?, ?)`
    ).run(accountId, now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO products (id, account_id, slug, name, status, created_at, updated_at)
       VALUES ('prd_identity', ?, 'identity-app', 'Identity App', 'active', ?, ?)`
    ).run(accountId, now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO license_plans (
         id, account_id, product_id, name, license_model, credential_mode,
         signed_token_ttl_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES ('lpl_identity', ?, 'prd_identity', 'Lifetime', 'perpetual', 'opaque',
         0, 0, 1, '[]', 'active', ?, ?)`
    ).run(accountId, now, now);
    for (const [licenseId, ownerId, keyHash] of [
      ["lic_identity", customerId, "hash_identity"],
      ["lic_other", "cus_other", "hash_other"],
    ]) {
      testEnv.sqliteDb.prepare(
        `INSERT INTO licenses (
           id, account_id, customer_id, product_id, plan_id, plan_revision,
           license_model, renewal_mode, credential_mode, signed_token_ttl_seconds,
           payment_grace_seconds, max_activations, features_json, key_hash,
           source, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'prd_identity', 'lpl_identity', 1, 'perpetual', 'none',
           'opaque', 0, 0, 1, '[]', ?, 'manual', 'active', ?, ?)`
      ).run(licenseId, accountId, ownerId, keyHash, now, now);
    }
    testEnv.sqliteDb.prepare(
      `INSERT INTO activations (
         id, account_id, license_id, fingerprint_hash, machine_token_hash,
         name, platform, status, activated_at, updated_at
       ) VALUES ('act_identity', ?, 'lic_identity', 'fp_identity', 'mt_identity',
         'Buyer Mac', 'macos', 'active', ?, ?)`
    ).run(accountId, now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO activations (
         id, account_id, license_id, fingerprint_hash, machine_token_hash,
         name, platform, status, activated_at, updated_at
       ) VALUES ('act_other', ?, 'lic_other', 'fp_other', 'mt_other',
         'Other Mac', 'macos', 'active', ?, ?)`
    ).run(accountId, now, now);
    const unknown = await app.request(
      "https://license.example.test/api/v1/customer/auth/magic-link",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({
          accountSlug: "identity",
          email: "unknown@example.test",
          turnstileToken: "turnstile-unknown",
        }),
      },
      testEnv.env
    );
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ success: true, data: { accepted: true } });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM customer_login_challenges").get()).toEqual({ count: 0 });

    const known = await app.request(
      "https://license.example.test/api/v1/customer/auth/magic-link",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({
          accountSlug: "identity",
          email: "buyer@example.test",
          turnstileToken: "turnstile-known",
        }),
      },
      testEnv.env
    );
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ success: true, data: { accepted: true } });
    const challenge = testEnv.sqliteDb.prepare(
      "SELECT id, token_hash, delivery_id FROM customer_login_challenges WHERE account_id = ?"
    ).get(accountId) as any;
    expect(challenge.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const delivery = testEnv.sqliteDb.prepare(
      "SELECT variables_ciphertext, status FROM email_deliveries WHERE account_id = ? AND id = ?"
    ).get(accountId, challenge.delivery_id) as any;
    expect(delivery.status).toBe("waiting_configuration");
    const variables = JSON.parse(await decryptEnvelopeV1(delivery.variables_ciphertext, testEnv.env, {
      accountId,
      table: "email_deliveries",
      rowId: challenge.delivery_id,
      field: "variables_ciphertext",
    }));
    const accessUrl = new URL(variables.access_url);
    expect(accessUrl.pathname).toBe("/site/customer/identity/auth");
    const token = accessUrl.hash.slice("#token=".length);

    const consume = await app.request(
      "https://license.example.test/api/v1/customer/auth/magic-link/consume",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({ accountSlug: "identity", token: decodeURIComponent(token) }),
      },
      testEnv.env
    );
    expect(consume.status).toBe(200);
    expect(consume.headers.get("set-cookie")).toContain(CUSTOMER_SESSION_COOKIE);
    expect(consume.headers.get("set-cookie")).toContain(CUSTOMER_ACCOUNT_COOKIE);
    expect(consume.headers.get("set-cookie")).toContain(CUSTOMER_CSRF_COOKIE);
    expect(consume.headers.get("set-cookie")).not.toContain(ADMIN_SESSION_COOKIE);
    const customerSession = cookieValue(consume, CUSTOMER_SESSION_COOKIE);
    const customerAccount = cookieValue(consume, CUSTOMER_ACCOUNT_COOKIE);
    const customerCsrf = cookieValue(consume, CUSTOMER_CSRF_COOKIE);
    const customerCookie = `${CUSTOMER_SESSION_COOKIE}=${customerSession}; ${CUSTOMER_ACCOUNT_COOKIE}=${customerAccount}; ${CUSTOMER_CSRF_COOKIE}=${customerCsrf}`;

    const licenses = await app.request(
      "https://license.example.test/api/v1/customer/licenses",
      { headers: { Cookie: customerCookie } },
      testEnv.env
    );
    expect(licenses.status).toBe(200);
    expect((await licenses.json() as any).data.items.map((item: any) => item.id)).toEqual(["lic_identity"]);

    const crossAccount = await app.request(
      "https://license.example.test/api/v1/customer/licenses",
      {
        headers: {
          Cookie: `${CUSTOMER_SESSION_COOKIE}=${customerSession}; ${CUSTOMER_ACCOUNT_COOKIE}=acc_foreign; ${CUSTOMER_CSRF_COOKIE}=${customerCsrf}`,
        },
      },
      testEnv.env
    );
    expect(crossAccount.status).toBe(401);

    const crossCustomer = await app.request(
      "https://license.example.test/api/v1/customer/licenses/lic_other/activations/act_other/deactivate",
      {
        method: "POST",
        headers: {
          Cookie: customerCookie,
          Origin: "https://license.example.test",
          "X-CSRF-Token": customerCsrf,
        },
      },
      testEnv.env
    );
    expect(crossCustomer.status).toBe(404);
    expect((testEnv.sqliteDb.prepare("SELECT status FROM activations WHERE id = 'act_other'").get() as any).status).toBe("active");

    const missingOrigin = await app.request(
      "https://license.example.test/api/v1/customer/licenses/lic_identity/activations/act_identity/deactivate",
      {
        method: "POST",
        headers: { Cookie: customerCookie, "X-CSRF-Token": customerCsrf },
      },
      testEnv.env
    );
    expect(missingOrigin.status).toBe(403);

    const missingCustomerCsrf = await app.request(
      "https://license.example.test/api/v1/customer/licenses/lic_identity/activations/act_identity/deactivate",
      { method: "POST", headers: { Cookie: customerCookie, Origin: "https://license.example.test" } },
      testEnv.env
    );
    expect(missingCustomerCsrf.status).toBe(403);

    const mismatchedCsrf = await app.request(
      "https://license.example.test/api/v1/customer/licenses/lic_identity/activations/act_identity/deactivate",
      {
        method: "POST",
        headers: {
          Cookie: customerCookie,
          Origin: "https://license.example.test",
          "X-CSRF-Token": "ccf_not-the-cookie-token",
        },
      },
      testEnv.env
    );
    expect(mismatchedCsrf.status).toBe(403);

    const forgedCsrf = "ccf_forged-but-header-and-cookie-match";
    const forgedCsrfCookie = `${CUSTOMER_SESSION_COOKIE}=${customerSession}; ${CUSTOMER_ACCOUNT_COOKIE}=${customerAccount}; ${CUSTOMER_CSRF_COOKIE}=${forgedCsrf}`;
    const csrfNotBoundToSession = await app.request(
      "https://license.example.test/api/v1/customer/licenses/lic_identity/activations/act_identity/deactivate",
      {
        method: "POST",
        headers: {
          Cookie: forgedCsrfCookie,
          Origin: "https://license.example.test",
          "X-CSRF-Token": forgedCsrf,
        },
      },
      testEnv.env
    );
    expect(csrfNotBoundToSession.status).toBe(403);

    testEnv.sqliteDb.prepare(
      "UPDATE customer_sessions SET created_at = '2000-01-01T00:00:00.000Z' WHERE account_id = ?"
    ).run(accountId);
    const staleRecentAuth = await app.request(
      "https://license.example.test/api/v1/customer/licenses/lic_identity/activations/act_identity/deactivate",
      {
        method: "POST",
        headers: {
          Cookie: customerCookie,
          Origin: "https://license.example.test",
          "X-CSRF-Token": customerCsrf,
        },
      },
      testEnv.env
    );
    expect(staleRecentAuth.status).toBe(401);
    expect((await staleRecentAuth.json() as any).error.code).toBe("CUSTOMER_RECENT_AUTH_REQUIRED");
    expect((testEnv.sqliteDb.prepare("SELECT status FROM activations WHERE id = 'act_identity'").get() as any).status).toBe("active");
    testEnv.sqliteDb.prepare(
      "UPDATE customer_sessions SET created_at = ? WHERE account_id = ?"
    ).run(now, accountId);

    const deactivate = await app.request(
      "https://license.example.test/api/v1/customer/licenses/lic_identity/activations/act_identity/deactivate",
      {
        method: "POST",
        headers: {
          Cookie: customerCookie,
          Origin: "https://license.example.test",
          "X-CSRF-Token": customerCsrf,
        },
      },
      testEnv.env
    );
    expect(deactivate.status).toBe(200);
    expect((testEnv.sqliteDb.prepare("SELECT status FROM activations WHERE id = 'act_identity'").get() as any).status).toBe("deactivated");

    const repeated = await app.request(
      "https://license.example.test/api/v1/customer/auth/magic-link/consume",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({ accountSlug: "identity", token: decodeURIComponent(token) }),
      },
      testEnv.env
    );
    expect(repeated.status).toBe(400);
    expect((await repeated.json() as any).error.code).toBe("CUSTOMER_MAGIC_LINK_INVALID");
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM customer_sessions").get()).toEqual({ count: 1 });
  });
});
