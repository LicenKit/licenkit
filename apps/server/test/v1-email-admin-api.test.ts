import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppContext, UserRole } from "../src/types";
import { sha256Hex } from "../src/infra/crypto";
import { decryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { dispatchDelivery } from "../src/infra/delivery/dispatcher";
import { errorHandler } from "../src/middleware/error";
import {
  adminEmailDeliveriesRouter,
  adminEmailIntegrationsRouter,
  adminEmailTemplateContractsRouter,
} from "../src/routes/admin/email.routes";
import { prepareEmailNotificationDelivery } from "../src/services/delivery/outbox";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const NOW = "2026-09-20T10:00:00.000Z";
const ORIGIN = "https://license.example.test";
const CSRF_TOKEN = "acf_email_admin_test_token";
const API_KEY = "re_email_admin_api_secret";
const ACCOUNT_ID = "acc_email_admin";
const CUSTOMER_ID = "cus_email_admin";

const VARIABLES = Object.freeze({
  product_id: "prd_00000000000000000000000000",
  product_name: "Example App",
  license_id: "lic_00000000000000000000000000",
  license_key: "LK-000000-000000-000000-000000-00",
  license_model: "subscription",
  expires_at: "2026-10-19T10:00:00.000Z",
});

function createAdminRouteApp(role: UserRole = "owner") {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_email_admin");
    c.set("accountId", ACCOUNT_ID);
    c.set("userId", "usr_email_owner");
    c.set("userRole", role);
    c.set("userEmail", "owner@example.test");
    c.set("sessionNamespace", "admin");
    c.set("sessionCsrfTokenHash", await sha256Hex(CSRF_TOKEN));
    await next();
  });
  app.route("/email-template-contracts", adminEmailTemplateContractsRouter);
  app.route("/email-integrations", adminEmailIntegrationsRouter);
  app.route("/email-deliveries", adminEmailDeliveriesRouter);
  return app;
}

function requestInit(method = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Origin: ORIGIN,
      "X-CSRF-Token": CSRF_TOKEN,
      Cookie: `__Host-licenkit-admin-csrf=${CSRF_TOKEN}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function json(response: Response): Promise<any> {
  return response.json() as Promise<any>;
}

describe("Admin Email API", () => {
  let testEnv: TestEnvContext;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    testEnv = createTestEnv({ ENVIRONMENT: "test", STORAGE_ENCRYPTION_KEY_ID: "test-primary" });
    testEnv.sqliteDb.prepare(
      `INSERT INTO system_settings (id, instance_name, app_url, site_url, initialized_at, updated_at)
       VALUES ('current', 'Email Admin', ?, 'https://site.example.test', ?, ?)`,
    ).run(ORIGIN, NOW, NOW);
    testEnv.sqliteDb.prepare(
      `INSERT INTO accounts (id, name, slug, status, created_at, updated_at)
       VALUES (?, 'Email Admin', 'email-admin', 'active', ?, ?)`,
    ).run(ACCOUNT_ID, NOW, NOW);
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, account_id, email, password_hash, name, role, status, created_at, updated_at)
       VALUES ('usr_email_owner', ?, 'owner@example.test', 'hash', 'Owner', 'owner', 'active', ?, ?)`,
    ).run(ACCOUNT_ID, NOW, NOW);
    testEnv.sqliteDb.prepare(
      `INSERT INTO customers (id, account_id, email, name, status, created_at, updated_at)
       VALUES (?, ?, 'buyer@example.test', 'Buyer', 'active', ?, ?)`,
    ).run(CUSTOMER_ID, ACCOUNT_ID, NOW, NOW);
  });

  async function createConfiguration(app = createAdminRouteApp()) {
    const integrationResponse = await app.request(`${ORIGIN}/email-integrations`, requestInit("POST", {
      provider: "resend",
      name: "Resend Primary",
      apiKey: API_KEY,
      defaultFromEmail: "licenses@example.test",
      defaultFromName: "Example Licenses",
      replyToEmail: "support@example.test",
      maxAutomaticAttempts: 4,
    }), testEnv.env);
    expect(integrationResponse.status).toBe(201);
    const integration = (await json(integrationResponse)).data;
    const bindingResponse = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/customer.license_issued`,
      requestInit("PUT", { contractVersion: 1, providerTemplateRef: "license-issued-v1" }),
      testEnv.env,
    );
    expect(bindingResponse.status).toBe(201);
    return { integration, binding: (await json(bindingResponse)).data };
  }

  it("publishes the code-defined contracts and Provider examples", async () => {
    const app = createAdminRouteApp("viewer");
    const contractsResponse = await app.request(`${ORIGIN}/email-template-contracts`, requestInit(), testEnv.env);
    expect(contractsResponse.status).toBe(200);
    const contracts = (await json(contractsResponse)).data.items;
    expect(contracts.map((item: any) => item.notificationType)).toEqual([
      "customer.license_issued",
      "customer.license_recovered",
      "customer.license_security_reset",
      "customer.portal_access_requested",
    ]);
    const exampleResponse = await app.request(
      `${ORIGIN}/email-template-contracts/customer.license_issued/versions/1/examples/resend`,
      requestInit(),
      testEnv.env,
    );
    expect((await json(exampleResponse)).data).toMatchObject({
      placeholderSyntax: "{{{variable_name}}}",
      fileName: "customer-license-issued-v1.resend.html",
    });
  });

  it("encrypts credentials and exposes no revision or persisted test evidence", async () => {
    const app = createAdminRouteApp();
    const { integration, binding } = await createConfiguration(app);
    expect(integration).toMatchObject({ provider: "resend", credentialConfigured: true, status: "active" });
    expect(integration).not.toHaveProperty("configurationRevision");
    expect(binding).not.toHaveProperty("bindingRevision");
    expect(binding).not.toHaveProperty("lastTestDeliveryId");
    const stored = testEnv.sqliteDb.prepare("SELECT credential_ciphertext FROM email_integrations WHERE id = ?").get(integration.id) as any;
    expect(stored.credential_ciphertext).not.toContain(API_KEY);
    expect(JSON.parse(await decryptEnvelopeV1(stored.credential_ciphertext, testEnv.env, {
      accountId: ACCOUNT_ID,
      table: "email_integrations",
      rowId: integration.id,
      field: "credential_ciphertext",
    }))).toEqual({ version: 1, apiKey: API_KEY });
  });

  it("requires a recipient and returns the direct configuration-test result without creating Delivery data", async () => {
    const app = createAdminRouteApp();
    const { integration } = await createConfiguration(app);
    const missingRecipient = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/customer.license_issued/test`,
      requestInit("POST", {}),
      testEnv.env,
    );
    expect(missingRecipient.status).toBe(400);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "email_test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const response = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/customer.license_issued/test`,
      requestInit("POST", { recipientEmail: "operator@example.test" }),
      testEnv.env,
    );
    expect(await json(response)).toMatchObject({ data: { providerAccepted: true, providerMessageId: "email_test" } });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM email_deliveries").get()).toEqual({ count: 0 });
  });

  it("returns an immediate test failure instead of persisting invalid configuration evidence", async () => {
    const app = createAdminRouteApp();
    const { integration } = await createConfiguration(app);
    testEnv.sqliteDb.prepare(
      "UPDATE email_integrations SET credential_ciphertext = 'invalid-envelope' WHERE id = ?",
    ).run(integration.id);

    const response = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/customer.license_issued/test`,
      requestInit("POST", { recipientEmail: "operator@example.test" }),
      testEnv.env,
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      data: {
        providerAccepted: false,
        error: { source: "licenkit" },
      },
    });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM email_deliveries").get()).toEqual({ count: 0 });
  });

  it("requires duplicate confirmation before manually resending an unknown Provider result", async () => {
    const app = createAdminRouteApp();
    await createConfiguration(app);
    const prepared = await prepareEmailNotificationDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId: ACCOUNT_ID,
      customerId: CUSTOMER_ID,
      notificationType: "customer.license_issued",
      contractVersion: 1,
      recipientEmail: "buyer@example.test",
      variables: VARIABLES,
      now: new Date(NOW),
    });
    await testEnv.d1.batch(prepared.statements);
    await dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId: ACCOUNT_ID,
      deliveryId: prepared.deliveryId,
      fetchImpl: vi.fn(async () => { throw new TypeError("connection reset"); }) as unknown as typeof fetch,
      now: new Date(NOW),
    });
    const denied = await app.request(`${ORIGIN}/email-deliveries/${prepared.deliveryId}/retry`, requestInit("POST", { confirmPossibleDuplicate: false }), testEnv.env);
    expect(denied.status).toBe(409);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "email_manual" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const confirmed = await app.request(`${ORIGIN}/email-deliveries/${prepared.deliveryId}/retry`, requestInit("POST", { confirmPossibleDuplicate: true }), testEnv.env);
    expect(await json(confirmed)).toMatchObject({ data: { id: prepared.deliveryId, status: "accepted", attemptCount: 2 } });
  });

  it("does not requeue waiting Deliveries through a disabled configuration", async () => {
    const app = createAdminRouteApp();
    const { integration, binding } = await createConfiguration(app);
    const prepared = await prepareEmailNotificationDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId: ACCOUNT_ID,
      customerId: CUSTOMER_ID,
      notificationType: "customer.license_issued",
      contractVersion: 1,
      recipientEmail: "buyer@example.test",
      variables: VARIABLES,
      now: new Date(NOW),
    });
    await testEnv.d1.batch(prepared.statements);
    testEnv.sqliteDb.prepare(
      "UPDATE email_deliveries SET status = 'waiting_configuration' WHERE id = ?",
    ).run(prepared.deliveryId);
    testEnv.sqliteDb.prepare(
      "UPDATE email_template_bindings SET status = 'disabled' WHERE id = ?",
    ).run(binding.id);

    const response = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/customer.license_issued/retry-waiting`,
      requestInit("POST", {}),
      testEnv.env,
    );
    expect(response.status).toBe(409);
    expect((await json(response)).error.code).toBe("EMAIL_CONFIGURATION_NOT_ACTIVE");
    expect(testEnv.sqliteDb.prepare(
      "SELECT status FROM email_deliveries WHERE id = ?",
    ).get(prepared.deliveryId)).toEqual({ status: "waiting_configuration" });
  });

  it("lets an administrator cancel an unsent Delivery and clears its sensitive variables", async () => {
    const app = createAdminRouteApp();
    const prepared = await prepareEmailNotificationDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId: ACCOUNT_ID,
      customerId: CUSTOMER_ID,
      notificationType: "customer.license_issued",
      contractVersion: 1,
      recipientEmail: "buyer@example.test",
      variables: VARIABLES,
      now: new Date(NOW),
    });
    await testEnv.d1.batch(prepared.statements);

    const response = await app.request(
      `${ORIGIN}/email-deliveries/${prepared.deliveryId}/cancel`,
      requestInit("POST", {}),
      testEnv.env,
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      data: { id: prepared.deliveryId, status: "cancelled" },
    });
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, variables_ciphertext, variables_expires_at,
              next_attempt_at, locked_by, locked_until
       FROM email_deliveries WHERE id = ?`,
    ).get(prepared.deliveryId)).toEqual({
      status: "cancelled",
      variables_ciphertext: null,
      variables_expires_at: null,
      next_attempt_at: null,
      locked_by: null,
      locked_until: null,
    });
    expect(testEnv.sqliteDb.prepare(
      `SELECT action, resource_id FROM audit_logs
       WHERE account_id = ? AND action = 'email.delivery.cancel'`,
    ).get(ACCOUNT_ID)).toEqual({
      action: "email.delivery.cancel",
      resource_id: prepared.deliveryId,
    });

    const retry = await app.request(
      `${ORIGIN}/email-deliveries/${prepared.deliveryId}/retry`,
      requestInit("POST", { confirmPossibleDuplicate: false }),
      testEnv.env,
    );
    expect(retry.status).toBe(409);
    expect((await json(retry)).error.code).toBe("EMAIL_DELIVERY_NOT_RETRYABLE");
  });

});
