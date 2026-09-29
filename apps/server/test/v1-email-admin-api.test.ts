import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppContext, InstanceRole } from "../src/types";
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
const FULL_ACCESS_API_KEY = "re_email_template_install_full_access";
const INSTANCE_ID = "acc_email_admin";
const CUSTOMER_ID = "cus_email_admin";

const VARIABLES = Object.freeze({
  product_id: "prd_00000000000000000000000000",
  product_name: "Example App",
  license_id: "lic_00000000000000000000000000",
  license_key: "LK-000000-000000-000000-000000-00",
  license_model: "subscription",
  expires_at: "2026-10-19T10:00:00.000Z",
});

function createAdminRouteApp(role: InstanceRole = "owner") {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_email_admin");
    c.set("instanceId", INSTANCE_ID);
    c.set("userId", "usr_email_owner");
    c.set("instanceRole", role);
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

function expectNoCamelCaseKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectNoCamelCaseKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    expect(key).not.toMatch(/[a-z][A-Z]/);
    expectNoCamelCaseKeys(item);
  }
}

describe("Admin Email API", () => {
  let testEnv: TestEnvContext;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    testEnv = createTestEnv({ ENVIRONMENT: "test", STORAGE_ENCRYPTION_KEY_ID: "test-primary" });
    testEnv.sqliteDb.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES (?, 'Email Admin', 'https://site.example.test', 'https://license.example.test', 'active', ?, ?)`,
    ).run(INSTANCE_ID, NOW, NOW);
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES ('usr_email_owner', 'owner@example.test', 'hash', 'Owner', ?, ?)`,
    ).run(NOW, NOW);
    testEnv.sqliteDb.prepare(
      `INSERT INTO customers (id, instance_id, email, name, status, created_at, updated_at)
       VALUES (?, ?, 'buyer@example.test', 'Buyer', 'active', ?, ?)`,
    ).run(CUSTOMER_ID, INSTANCE_ID, NOW, NOW);
  });

  async function createConfiguration(app = createAdminRouteApp()) {
    const integrationResponse = await app.request(`${ORIGIN}/email-integrations`, requestInit("POST", {
      provider: "resend",
      name: "Resend Primary",
      api_key: API_KEY,
      default_from_email: "licenses@example.test",
      default_from_name: "Example Licenses",
      reply_to_email: "support@example.test",
      max_automatic_attempts: 4,
    }), testEnv.env);
    expect(integrationResponse.status).toBe(201);
    const integration = (await json(integrationResponse)).data;
    const bindingResponse = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/customer.license_issued`,
      requestInit("PUT", { contract_version: 1, provider_template_ref: "license-issued-v1" }),
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
    expect(contracts.map((item: any) => item.notification_type)).toEqual([
      "customer.license_issued",
      "customer.license_recovered",
      "customer.license_security_reset",
      "customer.portal_access_requested",
      "instance.member_invited",
    ]);
    const exampleResponse = await app.request(
      `${ORIGIN}/email-template-contracts/customer.license_issued/versions/1/examples/resend`,
      requestInit(),
      testEnv.env,
    );
    const exampleBody = await json(exampleResponse);
    expect(exampleBody.data).toMatchObject({
      placeholder_syntax: "{{{variable_name}}}",
      file_name: "customer-license-issued-v1.resend.html",
    });
    expectNoCamelCaseKeys(exampleBody);
  });

  it("encrypts credentials and exposes no revision or persisted test evidence", async () => {
    const app = createAdminRouteApp();
    const { integration, binding } = await createConfiguration(app);
    expect(integration).toMatchObject({ provider: "resend", credential_configured: true, status: "active" });
    expect(integration).not.toHaveProperty("configuration_revision");
    expect(binding).not.toHaveProperty("binding_revision");
    expect(binding).not.toHaveProperty("last_test_delivery_id");
    expectNoCamelCaseKeys(integration);
    expectNoCamelCaseKeys(binding);
    const stored = testEnv.sqliteDb.prepare("SELECT credential_ciphertext FROM email_integrations WHERE id = ?").get(integration.id) as any;
    expect(stored.credential_ciphertext).not.toContain(API_KEY);
    expect(JSON.parse(await decryptEnvelopeV1(stored.credential_ciphertext, testEnv.env, {
      instanceId: INSTANCE_ID,
      table: "email_integrations",
      rowId: integration.id,
      field: "credential_ciphertext",
    }))).toEqual({ version: 1, apiKey: API_KEY });
  });

  it("installs only missing Resend defaults and never persists the temporary Full access key", async () => {
    const app = createAdminRouteApp();
    const { integration } = await createConfiguration(app);
    let sequence = 0;
    const providerFetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ message: "Template not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST" && url === "https://api.resend.com/templates") {
        sequence += 1;
        return new Response(JSON.stringify({ object: "template", id: `template_${sequence}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const templateId = url.match(/\/templates\/([^/]+)\/publish$/)?.[1];
      if (init?.method === "POST" && templateId) {
        return new Response(JSON.stringify({ object: "template", id: templateId }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Resend request: ${init?.method} ${url}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    const response = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/install-defaults`,
      requestInit("POST", { full_access_api_key: FULL_ACCESS_API_KEY }),
      testEnv.env,
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      data: {
        provider: "resend",
        installed_count: 4,
        skipped_count: 1,
        total_count: 5,
        complete: true,
      },
    });
    expectNoCamelCaseKeys(body);
    expect(providerFetch).toHaveBeenCalledTimes(12);
    expect(providerFetch.mock.calls.every(([, init]) =>
      new Headers(init?.headers).get("Authorization") === `Bearer ${FULL_ACCESS_API_KEY}`
    )).toBe(true);
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM email_template_bindings WHERE instance_id = ? AND email_integration_id = ?",
    ).get(INSTANCE_ID, integration.id)).toEqual({ count: 5 });
    expect(testEnv.sqliteDb.prepare(
      `SELECT COUNT(*) AS count FROM audit_logs
       WHERE instance_id = ? AND action = 'admin.email_template_binding.default_installed'`,
    ).get(INSTANCE_ID)).toEqual({ count: 4 });

    const stored = testEnv.sqliteDb.prepare(
      "SELECT credential_ciphertext FROM email_integrations WHERE id = ?",
    ).get(integration.id) as any;
    expect(JSON.parse(await decryptEnvelopeV1(stored.credential_ciphertext, testEnv.env, {
      instanceId: INSTANCE_ID,
      table: "email_integrations",
      rowId: integration.id,
      field: "credential_ciphertext",
    }))).toEqual({ version: 1, apiKey: API_KEY });
    const audits = testEnv.sqliteDb.prepare(
      "SELECT details_redacted_json FROM audit_logs WHERE instance_id = ?",
    ).all(INSTANCE_ID) as Array<{ details_redacted_json: string }>;
    expect(JSON.stringify(audits)).not.toContain(FULL_ACCESS_API_KEY);

    providerFetch.mockClear();
    const repeated = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/install-defaults`,
      requestInit("POST", { full_access_api_key: FULL_ACCESS_API_KEY }),
      testEnv.env,
    );
    expect(repeated.status).toBe(200);
    expect(await json(repeated)).toMatchObject({
      data: { installed_count: 0, skipped_count: 5, complete: true },
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("installs one requested default so the Admin UI can report real per-template progress", async () => {
    const app = createAdminRouteApp();
    const { integration } = await createConfiguration(app);
    const providerFetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ message: "Template not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST" && url === "https://api.resend.com/templates") {
        return new Response(JSON.stringify({ object: "template", id: "template_recovered" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST" && url.endsWith("/template_recovered/publish")) {
        return new Response(JSON.stringify({ object: "template", id: "template_recovered" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Resend request: ${init?.method} ${url}`);
    });
    vi.stubGlobal("fetch", providerFetch);

    const response = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/install-defaults`,
      requestInit("POST", {
        full_access_api_key: FULL_ACCESS_API_KEY,
        notification_type: "customer.license_recovered",
        contract_version: 1,
      }),
      testEnv.env,
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      data: {
        installed_count: 1,
        skipped_count: 0,
        total_count: 1,
        complete: true,
        items: [{
          notification_type: "customer.license_recovered",
          contract_version: 1,
          provider_template_ref: "template_recovered",
          outcome: "installed",
        }],
      },
    });
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps completed bindings when a later default template installation fails", async () => {
    const app = createAdminRouteApp();
    const { integration } = await createConfiguration(app);
    let createCount = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ message: "Template not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST" && url === "https://api.resend.com/templates") {
        createCount += 1;
        if (createCount === 2) {
          return new Response(JSON.stringify({
            name: "restricted_api_key",
            code: "invalid_permission",
            message: "Full access is required",
          }), {
            status: 403,
            headers: {
              "content-type": "application/json",
              "x-resend-request-id": "req_partial_install",
            },
          });
        }
        return new Response(JSON.stringify({ object: "template", id: "template_partial_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const templateId = url.match(/\/templates\/([^/]+)\/publish$/)?.[1];
      if (init?.method === "POST" && templateId) {
        return new Response(JSON.stringify({ object: "template", id: templateId }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Resend request: ${init?.method} ${url}`);
    }));

    const response = await app.request(
      `${ORIGIN}/email-integrations/${integration.id}/template-bindings/install-defaults`,
      requestInit("POST", { full_access_api_key: FULL_ACCESS_API_KEY }),
      testEnv.env,
    );
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body).toMatchObject({
      error: {
        code: "EMAIL_DEFAULT_TEMPLATE_INSTALL_PROVIDER_REJECTED",
        details: {
          provider: "resend",
          operation: "create_template",
          http_status: 403,
          provider_error_code: "invalid_permission",
          provider_request_id: "req_partial_install",
          failed_notification_type: "customer.license_security_reset",
          failed_contract_version: 1,
          installed_count: 1,
          skipped_count: 1,
          completed_count: 2,
          pending_count: 2,
          total_count: 5,
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain(FULL_ACCESS_API_KEY);
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM email_template_bindings WHERE instance_id = ? AND email_integration_id = ?",
    ).get(INSTANCE_ID, integration.id)).toEqual({ count: 2 });
    expect(testEnv.sqliteDb.prepare(
      `SELECT COUNT(*) AS count FROM audit_logs
       WHERE instance_id = ? AND action = 'admin.email_template_binding.default_installed'`,
    ).get(INSTANCE_ID)).toEqual({ count: 1 });
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
      requestInit("POST", { recipient_email: "operator@example.test" }),
      testEnv.env,
    );
    const body = await json(response);
    expect(body).toMatchObject({ data: { provider_accepted: true, provider_message_id: "email_test" } });
    expectNoCamelCaseKeys(body);
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
      requestInit("POST", { recipient_email: "operator@example.test" }),
      testEnv.env,
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      data: {
        provider_accepted: false,
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
      instanceId: INSTANCE_ID,
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
      instanceId: INSTANCE_ID,
      deliveryId: prepared.deliveryId,
      fetchImpl: vi.fn(async () => { throw new TypeError("connection reset"); }) as unknown as typeof fetch,
      now: new Date(NOW),
    });
    const denied = await app.request(`${ORIGIN}/email-deliveries/${prepared.deliveryId}/retry`, requestInit("POST", { confirm_possible_duplicate: false }), testEnv.env);
    expect(denied.status).toBe(409);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "email_manual" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const confirmed = await app.request(`${ORIGIN}/email-deliveries/${prepared.deliveryId}/retry`, requestInit("POST", { confirm_possible_duplicate: true }), testEnv.env);
    const confirmedBody = await json(confirmed);
    expect(confirmedBody).toMatchObject({ data: { id: prepared.deliveryId, status: "accepted", attempt_count: 2 } });
    expectNoCamelCaseKeys(confirmedBody);
  });

  it("does not requeue waiting Deliveries through a disabled configuration", async () => {
    const app = createAdminRouteApp();
    const { integration, binding } = await createConfiguration(app);
    const prepared = await prepareEmailNotificationDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
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
      instanceId: INSTANCE_ID,
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
       WHERE instance_id = ? AND action = 'email.delivery.cancel'`,
    ).get(INSTANCE_ID)).toEqual({
      action: "email.delivery.cancel",
      resource_id: prepared.deliveryId,
    });

    const retry = await app.request(
      `${ORIGIN}/email-deliveries/${prepared.deliveryId}/retry`,
      requestInit("POST", { confirm_possible_duplicate: false }),
      testEnv.env,
    );
    expect(retry.status).toBe(409);
    expect((await json(retry)).error.code).toBe("EMAIL_DELIVERY_NOT_RETRYABLE");
  });

  it("rejects legacy camelCase request bodies", async () => {
    const app = createAdminRouteApp();
    const response = await app.request(`${ORIGIN}/email-integrations`, requestInit("POST", {
      provider: "resend",
      name: "Legacy",
      apiKey: API_KEY,
      defaultFromEmail: "licenses@example.test",
    }), testEnv.env);
    expect(response.status).toBe(400);
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM email_integrations").get())
      .toEqual({ count: 0 });
  });

});
