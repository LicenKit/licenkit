import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/types";
import { errorHandler } from "../src/middleware/error";
import { sha256Hex } from "../src/infra/crypto";
import { encryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { adminLicensesRouter } from "../src/routes/admin/licenses.routes";
import { customerRouter } from "../src/routes/customer.routes";
import { issueManualLicense } from "../src/services/license/issue";
import {
  CUSTOMER_INSTANCE_COOKIE,
  CUSTOMER_CSRF_COOKIE,
  CUSTOMER_SESSION_COOKIE,
  createSessionSecrets,
} from "../src/services/identity/session";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const INSTANCE_ID = "acc_license_email";
const USER_ID = "usr_license_email";
const PRODUCT_ID = "prd_00000000000000000000000002";
const PLAN_ID = "lpl_license_email";
const INTEGRATION_ID = "emi_license_email";
const NOW = new Date("2026-09-20T10:00:00.000Z");

const TEMPLATE_BY_NOTIFICATION = Object.freeze({
  "customer.license_issued": "license-issued-v1",
  "customer.license_recovered": "license-recovered-v1",
  "customer.license_security_reset": "license-security-reset-v1",
});

type LicenseNotificationType = keyof typeof TEMPLATE_BY_NOTIFICATION;

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function adminApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_license_email_admin");
    c.set("instanceId", INSTANCE_ID);
    c.set("userId", USER_ID);
    c.set("instanceRole", "owner");
    c.set("userEmail", "owner@example.test");
    await next();
  });
  app.route("/admin/licenses", adminLicensesRouter);
  return app;
}

function customerApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.route("/api/v1/customer", customerRouter);
  return app;
}

describe("License email business paths", () => {
  let testEnv: TestEnvContext;

  beforeEach(() => {
    testEnv = createTestEnv({ STORAGE_ENCRYPTION_KEY_ID: "test-primary" });
    const nowIso = NOW.toISOString();
    testEnv.sqliteDb.prepare(
      `INSERT INTO instances (id, name, slug, site_url, admin_api_url, status, created_at, updated_at)
       VALUES (?, 'License Email Instance', 'license-email', 'https://license.example.test', 'https://license.example.test', 'active', ?, ?)`,
    ).run(INSTANCE_ID, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (
         id, email, password_hash, name,
         created_at, updated_at
       ) VALUES (?, 'owner@example.test', 'hash', 'Owner', ?, ?)`,
    ).run(USER_ID, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO products (
         id, instance_id, slug, name, description, billing_environment,
         trial_enabled, trial_duration_seconds, trial_features_json,
         status, created_at, updated_at
       ) VALUES (?, ?, 'license-email-product', 'License Email Product', NULL,
         NULL, 0, NULL, '[]', 'active', ?, ?)`,
    ).run(PRODUCT_ID, INSTANCE_ID, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, revision, license_model,
         credential_mode, default_term_seconds, update_window_seconds,
         signed_token_ttl_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'Perpetual', 1, 'perpetual', 'opaque', NULL, NULL,
         0, 0, 2, '[]', 'active', ?, ?)`,
    ).run(PLAN_ID, INSTANCE_ID, PRODUCT_ID, nowIso, nowIso);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function configureReadyEmail(
    notificationTypes: readonly LicenseNotificationType[],
  ): Promise<void> {
    const nowIso = NOW.toISOString();
    const credentialCiphertext = await encryptEnvelopeV1(
      JSON.stringify({ version: 1, apiKey: "re_license_email_secret" }),
      testEnv.env,
      {
        instanceId: INSTANCE_ID,
        table: "email_integrations",
        rowId: INTEGRATION_ID,
        field: "credential_ciphertext",
      },
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO email_integrations (
         id, instance_id, provider, name, credential_ciphertext,
         default_from_email, default_from_name, max_automatic_attempts,
         status, created_at, updated_at
       ) VALUES (?, ?, 'resend', 'Primary', ?, 'licenses@example.test',
         'License Email', 4, 'active', ?, ?)`,
    ).run(INTEGRATION_ID, INSTANCE_ID, credentialCiphertext, nowIso, nowIso);

    for (const [index, notificationType] of notificationTypes.entries()) {
      const bindingId = `etb_license_email_${index}`;
      testEnv.sqliteDb.prepare(
        `INSERT INTO email_template_bindings (
         id, instance_id, email_integration_id, notification_type,
           contract_version, provider_template_ref,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, 'active', ?, ?)`,
      ).run(
        bindingId,
        INSTANCE_ID,
        INTEGRATION_ID,
        notificationType,
        TEMPLATE_BY_NOTIFICATION[notificationType],
        nowIso,
        nowIso,
      );
    }
  }

  async function issueWithCustomerSession() {
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
      licensePlanId: PLAN_ID,
      customerEmail: "buyer@example.test",
      actor: { type: "user", id: USER_ID },
      now: NOW,
    });
    expect(issued.delivery.status).toBe("waiting_configuration");

    const session = await createSessionSecrets("cus");
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    testEnv.sqliteDb.prepare(
      `INSERT INTO customer_login_challenges (
         id, instance_id, customer_id, token_hash, expires_at, consumed_at,
         delivery_id, created_at
       ) VALUES ('mlc_license_email', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      INSTANCE_ID,
      issued.license.customerId,
      await sha256Hex("challenge-license-email"),
      expiresAt,
      nowIso,
      issued.delivery.id,
      nowIso,
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO customer_sessions (
         id, instance_id, customer_id, login_challenge_id,
         session_token_hash, csrf_token_hash, expires_at, created_at
       ) VALUES ('css_license_email', ?, ?, 'mlc_license_email', ?, ?, ?, ?)`,
    ).run(
      INSTANCE_ID,
      issued.license.customerId,
      session.sessionTokenHash,
      session.csrfTokenHash,
      expiresAt,
      nowIso,
    );
    return {
      issued,
      session,
      cookie: [
        `${CUSTOMER_SESSION_COOKIE}=${session.sessionToken}`,
        `${CUSTOMER_INSTANCE_COOKIE}=${INSTANCE_ID}`,
        `${CUSTOMER_CSRF_COOKIE}=${session.csrfToken}`,
      ].join("; "),
    };
  }

  it("dispatches all three Admin License notifications only after their domain batch commits", async () => {
    await configureReadyEmail([
      "customer.license_issued",
      "customer.license_recovered",
      "customer.license_security_reset",
    ]);
    const providerBodies: any[] = [];
    const committedVersions: number[] = [];
    const providerFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      providerBodies.push(body);
      const delivery = testEnv.sqliteDb.prepare(
        `SELECT status FROM email_deliveries
         WHERE instance_id = ? AND notification_type = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).get(INSTANCE_ID, Object.entries(TEMPLATE_BY_NOTIFICATION).find(([, template]) => template === body.template.id)?.[0]) as any;
      const license = testEnv.sqliteDb.prepare(
        `SELECT key_version FROM licenses WHERE instance_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).get(INSTANCE_ID) as any;
      expect(delivery?.status).toBe("processing");
      expect(license?.key_version).toBeGreaterThan(0);
      committedVersions.push(license.key_version);
      return jsonResponse({ id: `email_business_${providerBodies.length}` });
    });
    vi.stubGlobal("fetch", providerFetch);

    const legacyIssueResponse = await adminApp().request(
      "https://license.example.test/admin/licenses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          licensePlanId: PLAN_ID,
          customerEmail: "buyer@example.test",
        }),
      },
      testEnv.env,
    );
    expect(legacyIssueResponse.status).toBe(400);
    expect((await legacyIssueResponse.json() as any).error.code).toBe("VALIDATION_ERROR");

    const issueResponse = await adminApp().request(
      "https://license.example.test/admin/licenses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          license_plan_id: PLAN_ID,
          customer_email: "buyer@example.test",
        }),
      },
      testEnv.env,
    );
    expect(issueResponse.status).toBe(201);
    const issued = (await issueResponse.json() as any).data;
    expect(issued.delivery.status).toBe("accepted");
    expect(issued.license).toHaveProperty("license_key");
    expect(issued.license).not.toHaveProperty("licenseKey");

    const recoveryResponse = await adminApp().request(
      `https://license.example.test/admin/licenses/${issued.license.id}/recover-key`,
      { method: "POST" },
      testEnv.env,
    );
    expect(recoveryResponse.status).toBe(200);
    const recovered = (await recoveryResponse.json() as any).data;
    expect(recovered.delivery.status).toBe("accepted");

    const resetResponse = await adminApp().request(
      `https://license.example.test/admin/licenses/${issued.license.id}/security-reset`,
      { method: "POST" },
      testEnv.env,
    );
    expect(resetResponse.status).toBe(200);
    const reset = (await resetResponse.json() as any).data;
    expect(reset.delivery.status).toBe("accepted");

    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(committedVersions).toEqual([1, 2, 3]);
    expect(providerBodies.map((body) => body.template.id)).toEqual([
      "license-issued-v1",
      "license-recovered-v1",
      "license-security-reset-v1",
    ]);
    expect(providerBodies[0].template.variables).toMatchObject({
      instance_name: "License Email Instance",
      product_id: PRODUCT_ID,
      product_name: "License Email Product",
      license_id: issued.license.id,
      license_key: issued.license.license_key,
      license_model: "perpetual",
    });
    expect(providerBodies[0].template.variables).not.toHaveProperty("recipient_email");
    expect(providerBodies[0].template.variables).not.toHaveProperty("expires_at");
    expect(providerBodies[0].template.variables).not.toHaveProperty("updates_until");
    expect(providerBodies[1].template.variables.key_version).toBe(2);
    expect(providerBodies[2].template.variables.key_version).toBe(3);

    const auditJson = JSON.stringify(testEnv.sqliteDb.prepare(
      `SELECT details_redacted_json FROM audit_logs WHERE instance_id = ?
       ORDER BY created_at, id`,
    ).all(INSTANCE_ID));
    expect(auditJson).not.toContain(issued.license.license_key);
    expect(auditJson).not.toContain(recovered.license_key);
    expect(auditJson).not.toContain(reset.license_key);
  });

  it("uses waitUntil for Customer recovery and keeps the successful response when Provider delivery fails", async () => {
    await configureReadyEmail(["customer.license_recovered"]);
    const { issued, session, cookie } = await issueWithCustomerSession();

    let committedBeforeProvider = false;
    const providerFetch = vi.fn(async () => {
      const license = testEnv.sqliteDb.prepare(
        `SELECT key_version FROM licenses WHERE instance_id = ? AND id = ?`,
      ).get(INSTANCE_ID, issued.license.id) as any;
      const delivery = testEnv.sqliteDb.prepare(
        `SELECT status FROM email_deliveries
         WHERE instance_id = ? AND notification_type = 'customer.license_recovered'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).get(INSTANCE_ID) as any;
      committedBeforeProvider = license?.key_version === 2 && delivery?.status === "processing";
      return jsonResponse(
        { name: "application_error", message: "temporary Provider failure" },
        { status: 503 },
      );
    });
    vi.stubGlobal("fetch", providerFetch);
    const backgroundTasks: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil(promise: Promise<unknown>) {
        backgroundTasks.push(promise);
      },
      passThroughOnException() {},
    } as ExecutionContext;
    const response = await customerApp().request(
      `https://license.example.test/api/v1/customer/licenses/${issued.license.id}/recover-key`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://license.example.test",
          "X-CSRF-Token": session.csrfToken,
        },
      },
      testEnv.env,
      executionContext,
    );
    expect(response.status).toBe(200);
    const result = (await response.json() as any).data;
    expect(result.delivery.status).toBe("pending");
    expect(result.license.key_version).toBe(2);
    expect(backgroundTasks).toHaveLength(1);
    await expect(backgroundTasks[0]).resolves.toBeUndefined();
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(committedBeforeProvider).toBe(true);
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, attempt_count FROM email_deliveries WHERE id = ?`,
    ).get(result.delivery.id)).toEqual({
      status: "retry_scheduled",
      attempt_count: 1,
    });
    const auditJson = JSON.stringify(testEnv.sqliteDb.prepare(
      `SELECT details_redacted_json FROM audit_logs WHERE instance_id = ?`,
    ).all(INSTANCE_ID));
    expect(auditJson).not.toContain(result.license_key);
  });

  it("keeps the Customer recovery response successful when waitUntil registration fails", async () => {
    await configureReadyEmail(["customer.license_recovered"]);
    const { issued, session, cookie } = await issueWithCustomerSession();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
      { name: "application_error", message: "temporary Provider failure" },
      { status: 503 },
    )));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executionContext = {
      waitUntil() {
        throw new Error(`runtime rejected registration for ${issued.license.licenseKey}`);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext;

    const response = await customerApp().request(
      `https://license.example.test/api/v1/customer/licenses/${issued.license.id}/recover-key`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://license.example.test",
          "X-CSRF-Token": session.csrfToken,
        },
      },
      testEnv.env,
      executionContext,
    );
    expect(response.status).toBe(200);
    const result = (await response.json() as any).data;
    expect(result.license.key_version).toBe(2);
    expect(result.delivery.status).toBe("pending");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(issued.license.licenseKey);
    expect(testEnv.sqliteDb.prepare(
      `SELECT key_version FROM licenses WHERE instance_id = ? AND id = ?`,
    ).get(INSTANCE_ID, issued.license.id)).toEqual({ key_version: 2 });
  });
});
