import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/types";
import { sha256Hex } from "../src/infra/crypto";
import { errorHandler } from "../src/middleware/error";
import { customerSessionAuth } from "../src/middleware/auth";
import { customerRouter } from "../src/routes/customer.routes";
import {
  CUSTOMER_CSRF_COOKIE,
  CUSTOMER_INSTANCE_COOKIE,
  CUSTOMER_SESSION_COOKIE,
  createSessionSecrets,
} from "../src/services/identity/session";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const ORIGIN = "https://license.example.test";
const CUSTOMER_SITE_ORIGIN = "https://site.example.test";
const INSTANCE_A = "ins_customer_security_a";
const INSTANCE_B = "ins_customer_security_b";
const CUSTOMER_A = "cus_customer_security_a";
const CUSTOMER_B = "cus_customer_security_b";
const LICENSE_A = "lic_customer_security_a";
const LICENSE_B = "lic_customer_security_b";
const ACTIVATION_A = "act_customer_security_a";
const ACTIVATION_B = "act_customer_security_b";

interface SeededSession {
  instanceId: string;
  customerId: string;
  sessionToken: string;
  csrfToken: string;
  cookie: string;
}

function customerApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.route("/api/v1/customer", customerRouter);
  return app;
}

function customerCookie(input: {
  instanceId: string;
  sessionToken: string;
  csrfToken: string;
}): string {
  return [
    `${CUSTOMER_INSTANCE_COOKIE}=${input.instanceId}`,
    `${CUSTOMER_SESSION_COOKIE}=${input.sessionToken}`,
    `${CUSTOMER_CSRF_COOKIE}=${input.csrfToken}`,
  ].join("; ");
}

describe("V1 Customer Session security boundaries", () => {
  let testEnv: TestEnvContext;
  let sessionA: SeededSession;

  beforeEach(async () => {
    testEnv = createTestEnv({
      CUSTOMER_RECENT_AUTH_SECONDS: 900,
      CUSTOMER_SITE_ORIGIN,
    });
    const now = new Date();
    const nowIso = now.toISOString();

    for (const [instanceId, suffix] of [[INSTANCE_A, "a"], [INSTANCE_B, "b"]] as const) {
      testEnv.sqliteDb.prepare(
        `INSERT INTO instances (id, name, slug, site_url, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        instanceId,
        `Customer Security ${suffix.toUpperCase()}`,
        `customer-security-${suffix}`,
        `${CUSTOMER_SITE_ORIGIN}/customer/${suffix}`,
        nowIso,
        nowIso,
      );
    }

    for (const [customerId, instanceId, suffix] of [
      [CUSTOMER_A, INSTANCE_A, "a"],
      [CUSTOMER_B, INSTANCE_A, "b"],
    ] as const) {
      testEnv.sqliteDb.prepare(
        `INSERT INTO customers (id, instance_id, email, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        customerId,
        instanceId,
        `customer-${suffix}@example.test`,
        `Customer ${suffix.toUpperCase()}`,
        nowIso,
        nowIso,
      );
    }

    for (const [suffix, customerId, licenseId] of [
      ["a", CUSTOMER_A, LICENSE_A],
      ["b", CUSTOMER_B, LICENSE_B],
    ] as const) {
      const productId = `prd_customer_security_${suffix}`;
      const planId = `lpl_customer_security_${suffix}`;
      testEnv.sqliteDb.prepare(
        `INSERT INTO products (
           id, instance_id, slug, name, billing_environment,
           trial_enabled, trial_duration_seconds, trial_features_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, 0, NULL, '[]', 'active', ?, ?)`,
      ).run(
        productId,
        INSTANCE_A,
        `customer-security-${suffix}`,
        `Customer Security ${suffix.toUpperCase()}`,
        nowIso,
        nowIso,
      );
      testEnv.sqliteDb.prepare(
        `INSERT INTO license_plans (
           id, instance_id, product_id, name, revision, license_model,
           credential_mode, default_term_seconds, update_window_seconds,
           signed_token_ttl_seconds, payment_grace_seconds, max_activations,
           features_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'Perpetual', 1, 'perpetual', 'opaque', NULL, NULL,
           0, 0, 2, '[]', 'active', ?, ?)`,
      ).run(planId, INSTANCE_A, productId, nowIso, nowIso);
      testEnv.sqliteDb.prepare(
        `INSERT INTO licenses (
           id, instance_id, customer_id, product_id, plan_id, plan_revision,
           license_model, renewal_mode, credential_mode, signed_token_ttl_seconds,
           payment_grace_seconds, max_activations, features_json, key_hash,
           key_version, source, is_checkout_verification, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, 'perpetual', 'none', 'opaque', 0,
           0, 2, '[]', ?, 1, 'manual', 0, 'active', ?, ?)`,
      ).run(
        licenseId,
        INSTANCE_A,
        customerId,
        productId,
        planId,
        `key-hash-${suffix}`,
        nowIso,
        nowIso,
      );
    }

    for (const [suffix, licenseId, activationId] of [
      ["a", LICENSE_A, ACTIVATION_A],
      ["b", LICENSE_B, ACTIVATION_B],
    ] as const) {
      testEnv.sqliteDb.prepare(
        `INSERT INTO activations (
           id, instance_id, license_id, fingerprint_hash, machine_token_hash,
           name, platform, status, activated_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'macos', 'active', ?, ?)`,
      ).run(
        activationId,
        INSTANCE_A,
        licenseId,
        `fingerprint-${suffix}`,
        `machine-token-${suffix}`,
        `Customer ${suffix.toUpperCase()} device`,
        nowIso,
        nowIso,
      );
    }

    sessionA = await seedSession({
      id: "cse_customer_security_a",
      instanceId: INSTANCE_A,
      customerId: CUSTOMER_A,
      createdAt: nowIso,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    });
  });

  async function seedSession(input: {
    id: string;
    instanceId: string;
    customerId: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<SeededSession> {
    const secrets = await createSessionSecrets("cus");
    const challengeId = `clg_${input.id}`;
    const deliveryId = `edl_${input.id}`;
    testEnv.sqliteDb.prepare(
      `INSERT INTO email_deliveries (
         id, instance_id, recipient_type, customer_id, notification_type,
         contract_version, recipient_email, variables_ciphertext, status,
         attempt_count, created_at, updated_at
       ) SELECT ?, ?, 'customer', ?, 'customer.portal_access_requested', 1,
                email, NULL, 'expired', 0, ?, ?
         FROM customers WHERE instance_id = ? AND id = ?`,
    ).run(
      deliveryId,
      input.instanceId,
      input.customerId,
      input.createdAt,
      input.createdAt,
      input.instanceId,
      input.customerId,
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO customer_login_challenges (
         id, instance_id, customer_id, token_hash, expires_at,
         consumed_at, delivery_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      challengeId,
      input.instanceId,
      input.customerId,
      await sha256Hex(`challenge-${input.id}`),
      input.expiresAt,
      input.createdAt,
      deliveryId,
      input.createdAt,
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO customer_sessions (
         id, instance_id, customer_id, login_challenge_id,
         session_token_hash, csrf_token_hash, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.instanceId,
      input.customerId,
      challengeId,
      secrets.sessionTokenHash,
      secrets.csrfTokenHash,
      input.expiresAt,
      input.createdAt,
    );
    return {
      instanceId: input.instanceId,
      customerId: input.customerId,
      sessionToken: secrets.sessionToken,
      csrfToken: secrets.csrfToken,
      cookie: customerCookie({
        instanceId: input.instanceId,
        sessionToken: secrets.sessionToken,
        csrfToken: secrets.csrfToken,
      }),
    };
  }

  async function deactivate(input: {
    cookie?: string;
    origin?: string;
    csrfHeader?: string;
    licenseId?: string;
    activationId?: string;
  }): Promise<Response> {
    const headers = new Headers();
    if (input.cookie) headers.set("Cookie", input.cookie);
    if (input.origin) headers.set("Origin", input.origin);
    if (input.csrfHeader) headers.set("X-CSRF-Token", input.csrfHeader);
    return customerApp().request(
      `${ORIGIN}/api/v1/customer/licenses/${input.licenseId ?? LICENSE_A}/activations/${input.activationId ?? ACTIVATION_A}/deactivate`,
      { method: "POST", headers },
      testEnv.env,
    );
  }

  function expectActivationUntouched(licenseId = LICENSE_A, activationId = ACTIVATION_A): void {
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, deactivated_at FROM activations
       WHERE instance_id = ? AND license_id = ? AND id = ?`,
    ).get(INSTANCE_A, licenseId, activationId)).toEqual({
      status: "active",
      deactivated_at: null,
    });
    expect(testEnv.sqliteDb.prepare(
      `SELECT COUNT(*) AS count FROM audit_logs
       WHERE action = 'customer.activation.deactivated'`,
    ).get()).toEqual({ count: 0 });
  }

  it("does not reuse an Instance A session when the Instance cookie selects Instance B", async () => {
    const crossInstanceCookie = customerCookie({
      instanceId: INSTANCE_B,
      sessionToken: sessionA.sessionToken,
      csrfToken: sessionA.csrfToken,
    });
    const response = await customerApp().request(
      `${ORIGIN}/api/v1/customer/me`,
      { headers: { Cookie: crossInstanceCookie, Origin: CUSTOMER_SITE_ORIGIN } },
      testEnv.env,
    );

    expect(response.status).toBe(401);
    expect((await response.json() as any).error.code).toBe("UNAUTHORIZED");
  });

  it("updates last_seen_at only after a trusted Customer request succeeds", async () => {
    expect(testEnv.sqliteDb.prepare(
      "SELECT last_seen_at FROM customer_sessions WHERE instance_id = ? AND id = ?",
    ).get(INSTANCE_A, "cse_customer_security_a")).toEqual({ last_seen_at: null });

    const response = await customerApp().request(
      `${ORIGIN}/api/v1/customer/me`,
      { headers: { Cookie: sessionA.cookie, Origin: CUSTOMER_SITE_ORIGIN } },
      testEnv.env,
    );

    expect(response.status).toBe(200);
    expect(testEnv.sqliteDb.prepare(
      "SELECT last_seen_at FROM customer_sessions WHERE instance_id = ? AND id = ?",
    ).get(INSTANCE_A, "cse_customer_security_a")).toMatchObject({
      last_seen_at: expect.stringMatching(/Z$/),
    });
  });

  it("does not count a redirect as a successful Customer Session use", async () => {
    const app = new Hono<AppContext>();
    app.onError(errorHandler);
    app.use("*", customerSessionAuth);
    app.get("/redirect", (c) => c.redirect("https://site.example.test/customer", 302));

    const response = await app.request(
      `${ORIGIN}/redirect`,
      { headers: { Cookie: sessionA.cookie } },
      testEnv.env,
    );

    expect(response.status).toBe(302);
    expect(testEnv.sqliteDb.prepare(
      "SELECT last_seen_at FROM customer_sessions WHERE instance_id = ? AND id = ?",
    ).get(INSTANCE_A, "cse_customer_security_a")).toEqual({ last_seen_at: null });
  });

  it("does not count a downstream business error as a successful Customer Session use", async () => {
    const app = new Hono<AppContext>();
    app.onError(errorHandler);
    app.use("*", customerSessionAuth);
    app.get("/business-error", (c) => c.json({ success: false }, 400));

    const response = await app.request(
      `${ORIGIN}/business-error`,
      { headers: { Cookie: sessionA.cookie } },
      testEnv.env,
    );

    expect(response.status).toBe(400);
    expect(testEnv.sqliteDb.prepare(
      "SELECT last_seen_at FROM customer_sessions WHERE instance_id = ? AND id = ?",
    ).get(INSTANCE_A, "cse_customer_security_a")).toEqual({ last_seen_at: null });
  });

  it("keeps a successful business response when the best-effort last_seen update fails", async () => {
    const originalPrepare = testEnv.d1.prepare.bind(testEnv.d1);
    testEnv.d1.prepare = (query: string) => {
      if (query.includes("UPDATE customer_sessions SET last_seen_at")) {
        return {
          bind() {
            return {
              async run() {
                throw Object.assign(
                  new TypeError("forced last_seen write failure"),
                  { code: "D1_WRITE_FAILED" },
                );
              },
            };
          },
        };
      }
      return originalPrepare(query);
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await customerApp().request(
      `${ORIGIN}/api/v1/customer/me`,
      {
        headers: {
          Cookie: sessionA.cookie,
          Origin: CUSTOMER_SITE_ORIGIN,
          "X-Request-Id": "req_last_seen_touch_failure",
        },
      },
      testEnv.env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(errorLog).toHaveBeenCalledWith(
      "Customer Session last_seen update failed",
      {
        code: "CUSTOMER_SESSION_LAST_SEEN_UPDATE_FAILED",
        requestId: "req_last_seen_touch_failure",
        instanceId: INSTANCE_A,
        sessionId: "cse_customer_security_a",
        errorType: "TypeError",
        errorCode: "D1_WRITE_FAILED",
        errorMessage: "forced last_seen write failure",
      },
    );
    const serializedLog = JSON.stringify(errorLog.mock.calls);
    expect(serializedLog).not.toContain(sessionA.sessionToken);
    expect(serializedLog).not.toContain(sessionA.csrfToken);
    expect(serializedLog).not.toContain(sessionA.cookie);
    expect(testEnv.sqliteDb.prepare(
      "SELECT last_seen_at FROM customer_sessions WHERE instance_id = ? AND id = ?",
    ).get(INSTANCE_A, "cse_customer_security_a")).toEqual({ last_seen_at: null });
    errorLog.mockRestore();
  });

  it("does not let Customer A read or modify Customer B resources", async () => {
    const ownLicense = await customerApp().request(
      `${ORIGIN}/api/v1/customer/licenses/${LICENSE_A}`,
      { headers: { Cookie: sessionA.cookie, Origin: CUSTOMER_SITE_ORIGIN } },
      testEnv.env,
    );
    expect(ownLicense.status).toBe(200);

    const otherLicense = await customerApp().request(
      `${ORIGIN}/api/v1/customer/licenses/${LICENSE_B}`,
      { headers: { Cookie: sessionA.cookie, Origin: CUSTOMER_SITE_ORIGIN } },
      testEnv.env,
    );
    expect(otherLicense.status).toBe(404);

    const mutation = await deactivate({
      cookie: sessionA.cookie,
      origin: CUSTOMER_SITE_ORIGIN,
      csrfHeader: sessionA.csrfToken,
      licenseId: LICENSE_B,
      activationId: ACTIVATION_B,
    });
    expect(mutation.status).toBe(404);
    expectActivationUntouched(LICENSE_B, ACTIVATION_B);
  });

  it.each([
    {
      name: "missing Origin",
      headers: () => ({ cookie: sessionA.cookie, csrfHeader: sessionA.csrfToken }),
      code: "CUSTOMER_ORIGIN_REQUIRED",
    },
    {
      name: "missing CSRF Header",
      headers: () => ({ cookie: sessionA.cookie, origin: CUSTOMER_SITE_ORIGIN }),
      code: "CUSTOMER_CSRF_HEADER_MISSING",
    },
    {
      name: "mismatched CSRF Header and Cookie",
      headers: () => ({ cookie: sessionA.cookie, origin: CUSTOMER_SITE_ORIGIN, csrfHeader: "ccf_mismatch" }),
      code: "CUSTOMER_CSRF_TOKEN_MISMATCH",
    },
    {
      name: "a similar but untrusted Origin",
      headers: () => ({
        cookie: sessionA.cookie,
        origin: "https://site.example.test.evil.example",
        csrfHeader: sessionA.csrfToken,
      }),
      code: "CUSTOMER_ORIGIN_NOT_ALLOWED",
    },
  ])("rejects a Customer write with $name and preserves every side effect", async ({ headers, code }) => {
    const response = await deactivate(headers());
    expect(response.status).toBe(403);
    expect((await response.json() as any).error.code).toBe(code);
    expectActivationUntouched();
    expect(testEnv.sqliteDb.prepare(
      "SELECT last_seen_at FROM customer_sessions WHERE instance_id = ? AND id = ?",
    ).get(INSTANCE_A, "cse_customer_security_a")).toEqual({ last_seen_at: null });
  });

  it("rejects a matching forged CSRF Header/Cookie pair that is not bound to the Session", async () => {
    const forgedCsrf = "ccf_forged_but_matching";
    const forgedCookie = customerCookie({
      instanceId: sessionA.instanceId,
      sessionToken: sessionA.sessionToken,
      csrfToken: forgedCsrf,
    });
    const response = await deactivate({
      cookie: forgedCookie,
      origin: CUSTOMER_SITE_ORIGIN,
      csrfHeader: forgedCsrf,
    });

    expect(response.status).toBe(403);
    expect((await response.json() as any).error).toMatchObject({
      code: "CUSTOMER_CSRF_SESSION_MISMATCH",
      message: "Customer CSRF token is not bound to the current session",
    });
    expectActivationUntouched();
    expect(testEnv.sqliteDb.prepare(
      "SELECT last_seen_at FROM customer_sessions WHERE instance_id = ? AND id = ?",
    ).get(INSTANCE_A, "cse_customer_security_a")).toEqual({ last_seen_at: null });
  });

  it("rejects an expired Customer Session before a write and preserves the resource", async () => {
    const now = new Date();
    const expiredSession = await seedSession({
      id: "cse_customer_security_expired",
      instanceId: INSTANCE_A,
      customerId: CUSTOMER_A,
      createdAt: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
      expiresAt: new Date(now.getTime() - 60 * 1000).toISOString(),
    });
    const response = await deactivate({
      cookie: expiredSession.cookie,
      origin: CUSTOMER_SITE_ORIGIN,
      csrfHeader: expiredSession.csrfToken,
    });

    expect(response.status).toBe(401);
    expect((await response.json() as any).error.code).toBe("UNAUTHORIZED");
    expectActivationUntouched();
  });

  it("rejects stale recent authentication before a write and preserves the resource", async () => {
    const now = new Date();
    const staleSession = await seedSession({
      id: "cse_customer_security_stale",
      instanceId: INSTANCE_A,
      customerId: CUSTOMER_A,
      createdAt: new Date(now.getTime() - 16 * 60 * 1000).toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    });
    const response = await deactivate({
      cookie: staleSession.cookie,
      origin: CUSTOMER_SITE_ORIGIN,
      csrfHeader: staleSession.csrfToken,
    });

    expect(response.status).toBe(401);
    expect((await response.json() as any).error.code).toBe("CUSTOMER_RECENT_AUTH_REQUIRED");
    expectActivationUntouched();
  });
});
