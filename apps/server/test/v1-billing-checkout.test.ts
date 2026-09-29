import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { app } from "../src/index";
import type { AppContext } from "../src/types";
import { computeHmacSha256, sha256Hex } from "../src/infra/crypto";
import { encryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { encryptBillingProviderSecret, encryptInboundPayload } from "../src/infra/billing/storage";
import { processBillingInboundEvent, processDueBillingInboundEvents } from "../src/services/billing/fulfillment";
import { activateLicense, validateActivation } from "../src/services/license/activation";
import { listSystemIssues } from "../src/services/operations/system-issues";
import { reconcileBillingCustomer, syncTrustedBillingCustomer } from "../src/services/billing/customer-sync";
import { createCustomerPortalSession } from "../src/services/billing/customer-portal";
import { evaluateBillingOfferReadiness, getBillingOfferReadinessRow } from "../src/services/billing/readiness";
import { getPaddleWebhookRequirements } from "../src/services/billing/webhook-requirements";
import { clearExpiredInboundEventPayloads } from "../src/services/runtime/retention";
import { errorHandler } from "../src/middleware/error";
import { adminEmailDeliveriesRouter } from "../src/routes/admin/email.routes";
import { adminBillingRouter } from "../src/routes/admin/billing.routes";
import { adminCustomersRouter } from "../src/routes/customer-admin.routes";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const instanceId = "acc_billing_v1";
const providerId = "bpr_sandbox_v1";
const webhookSecret = "pdl_ntfsec_v1_test_secret_123456789";
const simulatorWebhookSecret = "pdl_ntfsec_simulator_test_secret_123456789";
const nowIso = "2026-09-19T08:00:00.000Z";

function addFirstToMockD1(d1: any): void {
  const originalPrepare = d1.prepare.bind(d1);
  const decorate = (statement: any): any => {
    const originalBind = statement.bind.bind(statement);
    statement.bind = (...params: unknown[]) => decorate(originalBind(...params));
    statement.first = async () => statement.get();
    return statement;
  };
  d1.prepare = (query: string) => decorate(originalPrepare(query));
}

function eventPayload(eventId: string, eventType: string, data: Record<string, unknown>, occurredAt = nowIso): string {
  return JSON.stringify({ event_id: eventId, event_type: eventType, occurred_at: occurredAt, data });
}

function billingAdminApp() {
  const admin = new Hono<AppContext>();
  admin.onError(errorHandler);
  admin.use("*", async (c, next) => {
    c.set("requestId", "req_billing_admin_snake_case");
    c.set("instanceId", instanceId);
    c.set("userId", "usr_billing_owner");
    c.set("instanceRole", "owner");
    c.set("userEmail", "owner@example.test");
    await next();
  });
  admin.route("/", adminBillingRouter);
  return admin;
}

function customerAdminApp() {
  const admin = new Hono<AppContext>();
  admin.onError(errorHandler);
  admin.use("*", async (c, next) => {
    c.set("requestId", "req_customer_admin_detail");
    c.set("instanceId", instanceId);
    c.set("userId", "usr_billing_owner");
    c.set("instanceRole", "owner");
    c.set("userEmail", "owner@example.test");
    await next();
  });
  admin.route("/", adminCustomersRouter);
  return admin;
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

describe("V1 Paddle billing and fulfillment contracts", () => {
  let testEnv: TestEnvContext;

  beforeEach(async () => {
    testEnv = createTestEnv({ ENVIRONMENT: "test", STORAGE_ENCRYPTION_KEY_ID: "test-primary" });
    addFirstToMockD1(testEnv.d1);
    testEnv.env.DB = testEnv.d1;
    const db = testEnv.sqliteDb;
    db.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES (?, 'Billing V1', 'https://licenses.example.test', 'https://admin.example.test', 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES ('usr_billing_owner', 'owner@example.test', 'hash', 'Owner', ?, ?)`,
    ).run(nowIso, nowIso);
    db.prepare(
      `INSERT INTO instance_memberships (
         instance_id, user_id, role, status, joined_by_invitation_id, created_at, updated_at
       ) VALUES (?, 'usr_billing_owner', 'owner', 'active', NULL, ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    db.prepare(
      `INSERT INTO deployment_bootstrap (singleton_key, completed_at)
       VALUES ('deployment', ?)`,
    ).run(nowIso);
    const encryptedSecret = await encryptBillingProviderSecret(
      webhookSecret,
      testEnv.env,
      instanceId,
      providerId,
      "webhook_secret_ciphertext",
    );
    db.prepare(
      `INSERT INTO billing_providers (
         id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'sandbox', 'test_client_token_v1', ?, 'active', ?, ?)`,
    ).run(providerId, instanceId, encryptedSecret, nowIso, nowIso);
    db.prepare(
      `INSERT INTO products (
         id, instance_id, name, status, created_at, updated_at
       ) VALUES ('prd_00000000000000000000000001', ?, 'One Time', 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    db.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         payment_grace_seconds, features_json, status, created_at, updated_at
       ) VALUES ('pln_one', ?, 'prd_00000000000000000000000001', 'One Time', 'perpetual', 'opaque',
         0, '[]', 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    db.prepare(
      `INSERT INTO billing_offers (
         id, instance_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_one', ?, ?, 'pri_one123', 'prd_00000000000000000000000001', 'pln_one',
         'one_time', 'active', ?, ?)`,
    ).run(instanceId, providerId, nowIso, nowIso);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses a strict snake_case Admin Billing contract", async () => {
    const admin = billingAdminApp();
    const providersResponse = await admin.request("http://test/providers", {}, testEnv.env);
    expect(providersResponse.status).toBe(200);
    const providersBody = await providersResponse.json() as any;
    expect(providersBody.data.items[0]).toMatchObject({
      id: providerId,
      client_side_token: "test_client_token_v1",
      webhook_secret_configured: true,
      webhook_verified_at: null,
      simulator_test_completed_at: null,
      required_event_types: [
        "customer.created",
        "customer.updated",
        "transaction.completed",
        "adjustment.created",
        "adjustment.updated",
      ],
      verified_event_types: [],
      missing_event_types: [
        "customer.created",
        "customer.updated",
        "transaction.completed",
        "adjustment.created",
        "adjustment.updated",
      ],
      api_key_configured: false,
      created_at: nowIso,
      updated_at: nowIso,
    });
    expectNoCamelCaseKeys(providersBody);

    const legacyResponse = await admin.request("http://test/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "paddle",
        environment: "live",
        clientSideToken: "live_legacy_client_token",
        webhookSecret: "legacy_webhook_secret_123456",
      }),
    }, testEnv.env);
    expect(legacyResponse.status).toBe(400);

    const createResponse = await admin.request("http://test/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "paddle",
        environment: "live",
        client_side_token: "live_admin_client_token_v1",
        webhook_secret: "live_webhook_secret_123456789",
      }),
    }, testEnv.env);
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json() as any;
    expect(createBody.data).toMatchObject({
      environment: "live",
      client_side_token: "live_admin_client_token_v1",
      webhook_secret_configured: true,
      webhook_verified_at: null,
      simulator_test_completed_at: null,
      api_key_configured: false,
    });
    expectNoCamelCaseKeys(createBody);

    const configurationCheckResponse = await admin.request(`http://test/providers/${providerId}/test`, {
      method: "POST",
    }, testEnv.env);
    expect(configurationCheckResponse.status).toBe(200);
    const configurationCheckBody = await configurationCheckResponse.json() as any;
    expect(configurationCheckBody.data).toEqual({
      provider_id: providerId,
      provider: "paddle",
      environment: "sandbox",
      client_side_token_valid: true,
      webhook_secret_decryptable: true,
      webhook_verified_at: null,
      simulator_test_completed_at: null,
      required_event_types: [
        "customer.created",
        "customer.updated",
        "transaction.completed",
        "adjustment.created",
        "adjustment.updated",
      ],
      verified_event_types: [],
      missing_event_types: [
        "customer.created",
        "customer.updated",
        "transaction.completed",
        "adjustment.created",
        "adjustment.updated",
      ],
      api_key_configured: false,
      api_key_customer_read: {
        status: "not_configured",
        operation: "customers.list",
        error_code: null,
        provider_code: null,
        http_status: null,
        request_id: null,
        retry_after: null,
        message: null,
      },
    });
    expect(configurationCheckBody.data).not.toHaveProperty("signature_sample_verified");
    expectNoCamelCaseKeys(configurationCheckBody);

    const testCheckoutResponse = await admin.request("http://test/offers/off_one/test-checkout-config", {}, testEnv.env);
    expect(testCheckoutResponse.status).toBe(200);
    const testCheckoutBody = await testCheckoutResponse.json() as any;
    expect(testCheckoutBody.data).toMatchObject({
      checkout: {
        client_side_token: "test_client_token_v1",
        price_id: "pri_one123",
      },
    });
    expect(testCheckoutBody.data).not.toHaveProperty("verification_token");
    expectNoCamelCaseKeys(testCheckoutBody);

    testEnv.sqliteDb.prepare("UPDATE billing_offers SET status = 'draft' WHERE id = 'off_one'").run();
    const draftCheckout = await admin.request("http://test/offers/off_one/test-checkout-config", {}, testEnv.env);
    expect(draftCheckout.status).toBe(409);
    expect((await draftCheckout.json() as any).error.code).toBe("BILLING_TEST_CHECKOUT_UNAVAILABLE");
  });

  it("probes the stored Paddle API key and retains Paddle's exact authentication error", async () => {
    await configureProviderApiKey("Bearer pdl_sdbx_apikey_wrongly_prefixed");
    const mockedFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("https://sandbox-api.paddle.com/customers?per_page=1");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer Bearer pdl_sdbx_apikey_wrongly_prefixed",
      });
      return new Response(JSON.stringify({
        error: { code: "authentication_malformed", detail: "Authentication header included, but incorrectly formatted." },
        meta: { request_id: "req_paddle_malformed" },
      }), { status: 403, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", mockedFetch);

    const response = await billingAdminApp().request(`http://test/providers/${providerId}/test`, {
      method: "POST",
    }, testEnv.env);
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.api_key_customer_read).toEqual({
      status: "error",
      operation: "customers.list",
      error_code: "BILLING_PROVIDER_API_AUTH_INVALID",
      provider_code: "authentication_malformed",
      http_status: 403,
      request_id: "req_paddle_malformed",
      retry_after: null,
      message: "Authentication header included, but incorrectly formatted.",
    });
    expect(mockedFetch).toHaveBeenCalledOnce();
  });

  it("confirms customer.read with the saved Sandbox key without returning customer data", async () => {
    await configureProviderApiKey("pdl_sdbx_apikey_test_secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "ctm_private" }],
      meta: { request_id: "req_paddle_customer_read" },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const response = await billingAdminApp().request(`http://test/providers/${providerId}/test`, {
      method: "POST",
    }, testEnv.env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data.api_key_customer_read).toEqual({
      status: "ok", operation: "customers.list", error_code: null,
      provider_code: null, http_status: 200, request_id: "req_paddle_customer_read",
      retry_after: null, message: null,
    });
    expect(JSON.stringify(body)).not.toContain("ctm_private");
  });

  async function postEvent(rawBody: string, secret = webhookSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await computeHmacSha256(`${timestamp}:${rawBody}`, secret);
    const response = await app.request(
      `/api/v1/webhooks/payments/${instanceId}/paddle/sandbox`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "paddle-signature": `ts=${timestamp};h1=${signature}` },
        body: rawBody,
      },
      testEnv.env,
    );
    return { response, body: await response.json() as any };
  }

  async function postSimulatorEvent(rawBody: string, secret = webhookSecret) {
    return postEvent(rawBody, secret);
  }

  async function paddleWebhookRequirements() {
    const provider = await testEnv.env.DB.prepare(
      `SELECT id, instance_id, api_secret_ciphertext,
              webhook_secret_ciphertext, simulator_webhook_secret_version
       FROM billing_providers
       WHERE instance_id = ?1 AND id = ?2`,
    ).bind(instanceId, providerId).first<{
      id: string;
      instance_id: string;
      api_secret_ciphertext: string | null;
      webhook_secret_ciphertext: string;
      simulator_webhook_secret_version: number;
    }>();
    if (!provider) throw new Error("Expected the Paddle provider fixture to exist.");
    return getPaddleWebhookRequirements(testEnv.env.DB, provider);
  }

  async function processEvent(inboundEventId: string, processingNow = new Date(Date.now() + 1_000)) {
    return processBillingInboundEvent({
      env: testEnv.env,
      instanceId,
      eventId: inboundEventId,
      workerId: `test_${inboundEventId}`,
      now: processingNow,
    });
  }

  it("exposes only the standard Paddle environment webhook route", async () => {
    const legacyResponse = await app.request(
      `/api/v1/webhooks/payments/billing-v1/${providerId}`,
      { method: "POST" },
      testEnv.env,
    );
    expect(legacyResponse.status).toBe(404);
  });

  it("routes signed Simulator events through the unified destination without fulfillment", async () => {
    const payload = eventPayload("ntfsimevt_customer_updated", "customer.updated", {
      id: "ctm_sim_customer",
      email: "simulator@example.test",
    });

    expect((await postSimulatorEvent(payload, simulatorWebhookSecret)).response.status).toBe(401);

    const accepted = await postSimulatorEvent(payload);
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.data).toMatchObject({
      traffic_source: "simulation",
      event_type: "customer.updated",
      counted_for_verification: true,
    });
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM inbound_events").get())
      .toEqual({ count: 0 });
    expect(testEnv.sqliteDb.prepare(
      `SELECT event_type, simulator_webhook_secret_version
       FROM billing_webhook_simulation_tests`,
    ).all()).toEqual([{
      event_type: "customer.updated",
      simulator_webhook_secret_version: 1,
    }]);

    const requirements = await paddleWebhookRequirements();
    expect(requirements.verifiedEventTypes).toEqual(["customer.updated"]);
    expect(requirements.missingEventTypes).toEqual([
      "customer.created",
      "transaction.completed",
      "adjustment.created",
      "adjustment.updated",
    ]);

    const unsupported = await postSimulatorEvent(eventPayload(
      "ntfsimevt_product_updated",
      "product.updated",
      { id: "pro_simulator" },
    ));
    expect(unsupported.response.status).toBe(200);
    expect(unsupported.body.data.counted_for_verification).toBe(false);
    expect(testEnv.sqliteDb.prepare(
      "SELECT count(*) AS count FROM billing_webhook_simulation_tests",
    ).get()).toEqual({ count: 1 });
  });

  it("rejects an unknown signed event source instead of treating it as a purchase", async () => {
    const posted = await postEvent(eventPayload(
      "unknown_customer_updated", "customer.updated", { id: "ctm_unknown" },
    ));
    expect(posted.response.status).toBe(422);
    expect(posted.body.error.code).toBe("BILLING_WEBHOOK_SOURCE_UNKNOWN");
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM inbound_events").get())
      .toEqual({ count: 0 });
  });

  it("ignores a legacy misrouted Simulator purchase and refuses to replay it as a platform event", async () => {
    const eventId = "ine_legacy_simulation";
    const externalEventId = "ntfsimevt_legacy_purchase";
    const rawBody = eventPayload(externalEventId, "transaction.completed", {
      id: "txn_legacy_simulation",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
    });
    const ciphertext = await encryptInboundPayload(rawBody, testEnv.env, instanceId, eventId);
    testEnv.sqliteDb.prepare(
      `INSERT INTO inbound_events (
         id, instance_id, billing_provider_id, external_event_id, external_event_type,
         payload_ciphertext, payload_hash, payload_expires_at, status,
         received_at, updated_at
       ) VALUES (?, ?, ?, ?, 'transaction.completed', ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      eventId, instanceId, providerId, externalEventId, ciphertext, await sha256Hex(rawBody),
      new Date(Date.now() + 86_400_000).toISOString(), nowIso, nowIso,
    );

    const eventList = await billingAdminApp().request("http://test/events", {}, testEnv.env);
    expect(eventList.status).toBe(200);
    expect((await eventList.json() as any).data.items[0]).toMatchObject({
      event_type: "transaction.completed",
      provider: "paddle",
      environment: "sandbox",
      external_event_id: externalEventId,
    });
    const eventDetail = await billingAdminApp().request(`http://test/events/${eventId}`, {}, testEnv.env);
    expect((await eventDetail.json() as any).data).toMatchObject({
      event_type: "transaction.completed",
      environment: "sandbox",
    });

    const providers = await billingAdminApp().request("http://test/providers", {}, testEnv.env);
    expect((await providers.json() as any).data.items[0].webhook_verified_at).toBeNull();
    expect(await processEvent(eventId)).toEqual({ processed: true, status: "processed" });
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, result_type, last_error_code FROM inbound_events WHERE id = ?",
    ).get(eventId)).toEqual({
      status: "processed", result_type: "ignored_simulation_event", last_error_code: null,
    });

    testEnv.sqliteDb.prepare(
      `UPDATE inbound_events SET status = 'needs_attention',
         last_error_code = 'BILLING_OFFER_MAPPING_MISSING' WHERE id = ?`,
    ).run(eventId);
    const replay = await billingAdminApp().request(`http://test/events/${eventId}/replay`, {
      method: "POST",
    }, testEnv.env);
    expect(replay.status).toBe(409);
    expect((await replay.json() as any).error.code).toBe("BILLING_EVENT_NOT_REPLAYABLE");
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, last_error_code FROM inbound_events WHERE id = ?",
    ).get(eventId)).toEqual({
      status: "needs_attention", last_error_code: "BILLING_OFFER_MAPPING_MISSING",
    });
  });

  it("requires every selected event type and invalidates Simulator evidence after secret rotation", async () => {
    const oneTimeEventTypes = [
      "customer.created",
      "customer.updated",
      "transaction.completed",
      "adjustment.created",
      "adjustment.updated",
    ] as const;
    for (const [index, eventType] of oneTimeEventTypes.entries()) {
      const posted = await postSimulatorEvent(eventPayload(
        `ntfsimevt_one_time_${index}`,
        eventType,
        { id: `sim_one_time_${index}` },
      ));
      expect(posted.response.status).toBe(200);
      expect(posted.body.data.counted_for_verification).toBe(true);
    }

    const oneTimeRequirements = await paddleWebhookRequirements();
    expect(oneTimeRequirements.requiredEventTypes).toEqual(oneTimeEventTypes);
    expect(oneTimeRequirements.missingEventTypes).toEqual([]);
    expect(oneTimeRequirements.completedAt).toEqual(expect.any(String));

    testEnv.sqliteDb.prepare(
      `INSERT INTO products (
         id, instance_id, name, status, created_at, updated_at
       ) VALUES ('prd_sim_subscription', ?, 'Simulator Subscription', 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         payment_grace_seconds, features_json, status, created_at, updated_at
       ) VALUES ('pln_sim_subscription', ?, 'prd_sim_subscription', 'Simulator Subscription',
         'subscription', 'opaque', 0, '[]', 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_offers (
         id, instance_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_sim_subscription', ?, ?, 'pri_sim_subscription', 'prd_sim_subscription',
         'pln_sim_subscription', 'subscription', 'draft', ?, ?)`,
    ).run(instanceId, providerId, nowIso, nowIso);

    const subscriptionRequirements = await paddleWebhookRequirements();
    expect(subscriptionRequirements.requiredEventTypes).toEqual([
      ...oneTimeEventTypes,
      "subscription.created",
      "subscription.updated",
    ]);
    expect(subscriptionRequirements.missingEventTypes).toEqual([
      "subscription.created",
      "subscription.updated",
    ]);
    expect(subscriptionRequirements.completedAt).toBeNull();

    for (const [index, eventType] of ["subscription.created", "subscription.updated"].entries()) {
      expect((await postSimulatorEvent(eventPayload(
        `ntfsimevt_subscription_${index}`,
        eventType,
        { id: `sub_simulator_${index}` },
      ))).response.status).toBe(200);
    }
    expect((await paddleWebhookRequirements()).missingEventTypes).toEqual([]);

    const rotatedSecret = "pdl_ntfsec_simulator_rotated_secret_123456789";
    const rotationResponse = await billingAdminApp().request(`http://test/providers/${providerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhook_secret: rotatedSecret }),
    }, testEnv.env);
    expect(rotationResponse.status).toBe(200);
    expect(testEnv.sqliteDb.prepare(
      "SELECT simulator_webhook_secret_version FROM billing_providers WHERE id = ?",
    ).get(providerId)).toEqual({ simulator_webhook_secret_version: 2 });

    const afterRotation = await paddleWebhookRequirements();
    expect(afterRotation.verifiedEventTypes).toEqual([]);
    expect(afterRotation.missingEventTypes).toEqual(afterRotation.requiredEventTypes);
    expect(afterRotation.completedAt).toBeNull();

    const afterRotationPayload = eventPayload(
      "ntfsimevt_after_rotation",
      "transaction.completed",
      { id: "txn_sim_after_rotation" },
    );
    expect((await postSimulatorEvent(afterRotationPayload)).response.status).toBe(401);
    expect((await postSimulatorEvent(afterRotationPayload, rotatedSecret)).response.status).toBe(200);
    expect((await paddleWebhookRequirements()).verifiedEventTypes).toEqual(["transaction.completed"]);
  });

  function seedLinkedCustomer(externalCustomerId = "ctm_buyer1", email = "buyer@example.test"): void {
    testEnv.sqliteDb.prepare(
      `INSERT INTO customers (id, instance_id, email, name, status, created_at, updated_at)
       VALUES ('cus_buyer', ?, ?, 'Buyer', 'active', ?, ?)`,
    ).run(instanceId, email, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_customers (
         id, instance_id, billing_provider_id, customer_id, external_customer_id,
         provider_email, provider_status, link_status, last_sync_source,
         external_updated_at, created_at, updated_at
       ) VALUES ('bcu_buyer', ?, ?, 'cus_buyer', ?, ?, 'active', 'linked',
         'webhook', ?, ?, ?)`,
    ).run(instanceId, providerId, externalCustomerId, email, nowIso, nowIso, nowIso);
  }

  it("links Sandbox and Live billing customers with the same email to one customer", async () => {
    seedLinkedCustomer();
    const liveProviderId = "bpr_live_same_email";
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_providers (
         id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'live', 'live_same_email_token', 'encrypted', 'active', ?, ?)`,
    ).run(liveProviderId, instanceId, nowIso, nowIso);
    const liveMapping = await syncTrustedBillingCustomer({
      db: testEnv.d1,
      instanceId,
      billingProviderId: liveProviderId,
      snapshot: {
        externalCustomerId: "ctm_live_same_email",
        email: " Buyer@Example.Test ",
        name: "Buyer",
        status: "active",
        externalUpdatedAt: nowIso,
        externalEventId: "evt_live_same_email",
      },
      source: "webhook",
    });
    expect(liveMapping.customer_id).toBe("cus_buyer");
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM customers WHERE instance_id = ?").get(instanceId))
      .toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM billing_customers WHERE customer_id = 'cus_buyer'").get())
      .toEqual({ count: 2 });
  });

  async function issueOneTimeLicense(transactionId = "txn_purchase1"): Promise<{ eventId: string; licenseId: string }> {
    const payload = eventPayload(`evt_${transactionId}`, "transaction.completed", {
      id: transactionId,
      customer_id: "ctm_buyer1",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
    });
    const posted = await postEvent(payload);
    expect(posted.response.status).toBe(200);
    const result = await processEvent(posted.body.data.event_id);
    expect(result.status).toBe("processed");
    const license = testEnv.sqliteDb.prepare(
      "SELECT id FROM licenses WHERE source_external_transaction_id = ?",
    ).get(transactionId) as { id: string };
    return { eventId: posted.body.data.event_id, licenseId: license.id };
  }

  it("keeps Live and Sandbox Offers active on one Product and binds a Sandbox purchase to Sandbox use", async () => {
    const liveProviderId = "bpr_live_same_product";
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_providers (
         id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'live', 'live_same_product_token', 'encrypted', 'active', ?, ?)`,
    ).run(liveProviderId, instanceId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_offers (
         id, instance_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_live_same_product', ?, ?, 'pri_live_same_product',
         'prd_00000000000000000000000001', 'pln_one', 'one_time', 'active', ?, ?)`,
    ).run(instanceId, liveProviderId, nowIso, nowIso);

    seedLinkedCustomer();
    await configureLicenseIssuedEmail();
    const deliveries: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      deliveries.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "email_sandbox_purchase" }), {
        status: 202, headers: { "content-type": "application/json" },
      });
    }));
    const { licenseId } = await issueOneTimeLicense("txn_sandbox_same_product");
    expect(testEnv.sqliteDb.prepare(
      "SELECT billing_environment, source_billing_provider_id FROM licenses WHERE id = ?",
    ).get(licenseId)).toEqual({ billing_environment: "sandbox", source_billing_provider_id: providerId });
    const customerList = await customerAdminApp().request("http://test/", {}, testEnv.env);
    expect(customerList.status).toBe(200);
    expect((await customerList.json() as any).data.items[0]).toMatchObject({
      id: "cus_buyer", has_sandbox_license: true, has_live_license: false,
    });
    const customerDetail = await customerAdminApp().request("http://test/cus_buyer", {}, testEnv.env);
    expect(customerDetail.status).toBe(200);
    expect((await customerDetail.json() as any).data.licenses).toEqual([
      expect.objectContaining({ id: licenseId, billing_environment: "sandbox", product_name: "One Time" }),
    ]);
    expect(deliveries).toHaveLength(1);
    const licenseKey = deliveries[0].template.variables.license_key as string;
    const activation = {
      db: testEnv.d1, env: testEnv.env, instanceId,
      productId: "prd_00000000000000000000000001",
      licenseKey, machineToken: "mtk_sandbox_same_product_secret_123456",
      fingerprint: "sha256:sandbox-same-product", releaseVersion: "1.0.0",
      releasePlatform: "macos", releaseArch: "arm64",
    };
    await expect(activateLicense({ ...activation, billingEnvironment: "live" }))
      .rejects.toMatchObject({ code: "LICENSE_ENVIRONMENT_MISMATCH" });
    const sandboxActivation = await activateLicense({ ...activation, billingEnvironment: "sandbox" });
    expect(sandboxActivation.billing_environment).toBe("sandbox");
    await expect(validateActivation({
      db: testEnv.d1, env: testEnv.env, instanceId, productId: activation.productId,
      activationId: sandboxActivation.activation_id, machineToken: activation.machineToken,
      fingerprint: activation.fingerprint, releaseVersion: activation.releaseVersion,
      releasePlatform: activation.releasePlatform, releaseArch: activation.releaseArch,
      billingEnvironment: "live",
    })).rejects.toMatchObject({ code: "LICENSE_ENVIRONMENT_MISMATCH" });
    const validated = await validateActivation({
      db: testEnv.d1, env: testEnv.env, instanceId, productId: activation.productId,
      activationId: sandboxActivation.activation_id, machineToken: activation.machineToken,
      fingerprint: activation.fingerprint, releaseVersion: activation.releaseVersion,
      releasePlatform: activation.releasePlatform, releaseArch: activation.releaseArch,
      billingEnvironment: "sandbox",
    });
    expect(validated.billing_environment).toBe("sandbox");
  });

  async function configureProviderApiKey(apiKey = "pdl_sdbx_apikey_v1"): Promise<void> {
    const encrypted = await encryptBillingProviderSecret(
      apiKey,
      testEnv.env,
      instanceId,
      providerId,
      "api_secret_ciphertext",
    );
    testEnv.sqliteDb.prepare(
      "UPDATE billing_providers SET api_secret_ciphertext = ? WHERE instance_id = ? AND id = ?",
    ).run(encrypted, instanceId, providerId);
  }

  async function configureLicenseIssuedEmail(): Promise<void> {
    const integrationId = "emi_billing_fulfillment";
    const credentialCiphertext = await encryptEnvelopeV1(
      JSON.stringify({ version: 1, apiKey: "re_billing_fulfillment" }),
      testEnv.env,
      {
        instanceId,
        table: "email_integrations",
        rowId: integrationId,
        field: "credential_ciphertext",
      },
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO email_integrations (
         id, instance_id, provider, name, credential_ciphertext,
         default_from_email, max_automatic_attempts,
         status, created_at, updated_at
       ) VALUES (?, ?, 'resend', 'Billing', ?, 'licenses@example.test',
         4, 'active', ?, ?)`,
    ).run(integrationId, instanceId, credentialCiphertext, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO email_template_bindings (
         id, instance_id, email_integration_id, notification_type,
         contract_version, provider_template_ref,
         status, created_at, updated_at
       ) VALUES ('etb_billing_fulfillment', ?, ?, 'customer.license_issued',
         1, 'license-issued-v1', 'active', ?, ?)`,
    ).run(instanceId, integrationId, nowIso, nowIso);
  }

  it("verifies the raw signature and persists one encrypted event idempotently", async () => {
    const payload = eventPayload("evt_customer_signature", "customer.updated", {
      id: "ctm_signature1",
      email: "signed@example.test",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    });
    const rejected = await postEvent(payload, "wrong-secret");
    expect(rejected.response.status).toBe(401);
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM inbound_events").get()).toEqual({ count: 0 });

    const first = await postEvent(payload);
    const duplicate = await postEvent(payload);
    expect(first.response.status).toBe(200);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body.data.duplicate).toBe(true);
    expect(duplicate.body.data.payload_refreshed).toBe(false);
    expect(duplicate.body.data).not.toHaveProperty("payloadRefreshed");
    const rows = testEnv.sqliteDb.prepare(
      `SELECT payload_ciphertext, payload_hash, webhook_secret_version
       FROM inbound_events WHERE external_event_id = ?`,
    ).all("evt_customer_signature") as Array<{
      payload_ciphertext: string;
      payload_hash: string;
      webhook_secret_version: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_ciphertext).not.toContain("signed@example.test");
    expect(rows[0].payload_hash).toBe(await sha256Hex(payload));
    expect(rows[0].webhook_secret_version).toBe(1);

    const providersAfterWebhook = await billingAdminApp().request("http://test/providers", {}, testEnv.env);
    const providersAfterWebhookBody = await providersAfterWebhook.json() as any;
    expect(providersAfterWebhookBody.data.items[0].webhook_verified_at).toEqual(expect.any(String));

    const conflicting = await postEvent(eventPayload("evt_customer_signature", "customer.updated", {
      id: "ctm_signature1",
      email: "different@example.test",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    }));
    expect(conflicting.response.status).toBe(409);
    expect(conflicting.body.error.code).toBe("BILLING_WEBHOOK_EVENT_ID_CONFLICT");
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM inbound_events").get()).toEqual({ count: 1 });
  });

  it("invalidates webhook verification evidence when the secret rotates", async () => {
    const originalPayload = eventPayload("evt_before_secret_rotation", "customer.updated", {
      id: "ctm_before_rotation",
      email: "before-rotation@example.test",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    });
    expect((await postEvent(originalPayload)).response.status).toBe(200);

    const admin = billingAdminApp();
    const beforeRotationResponse = await admin.request(`http://test/providers/${providerId}/test`, {
      method: "POST",
    }, testEnv.env);
    const beforeRotationBody = await beforeRotationResponse.json() as any;
    expect(beforeRotationBody.data.webhook_verified_at).toEqual(expect.any(String));

    const rotatedSecret = "pdl_ntfsec_v2_rotated_secret_123456789";
    const rotationResponse = await admin.request(`http://test/providers/${providerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhook_secret: rotatedSecret }),
    }, testEnv.env);
    expect(rotationResponse.status).toBe(200);
    expect(testEnv.sqliteDb.prepare(
      "SELECT webhook_secret_version FROM billing_providers WHERE id = ?",
    ).get(providerId)).toEqual({ webhook_secret_version: 2 });

    const afterRotationResponse = await admin.request(`http://test/providers/${providerId}/test`, {
      method: "POST",
    }, testEnv.env);
    const afterRotationBody = await afterRotationResponse.json() as any;
    expect(afterRotationBody.data.webhook_verified_at).toBeNull();

    const oldSecretEvent = eventPayload("evt_old_secret_after_rotation", "customer.updated", {
      id: "ctm_old_secret_after_rotation",
      email: "old-secret@example.test",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    });
    expect((await postEvent(oldSecretEvent)).response.status).toBe(401);

    const retriedWithRotatedSecret = await postEvent(originalPayload, rotatedSecret);
    expect(retriedWithRotatedSecret.response.status).toBe(200);
    expect(retriedWithRotatedSecret.body.data.duplicate).toBe(true);
    expect(testEnv.sqliteDb.prepare(
      `SELECT webhook_secret_version
       FROM inbound_events WHERE external_event_id = 'evt_before_secret_rotation'`,
    ).get()).toEqual({ webhook_secret_version: 2 });

    const verifiedAgainResponse = await admin.request(`http://test/providers/${providerId}/test`, {
      method: "POST",
    }, testEnv.env);
    const verifiedAgainBody = await verifiedAgainResponse.json() as any;
    expect(verifiedAgainBody.data.webhook_verified_at).toEqual(expect.any(String));
  });

  it("refreshes an expired payload only for the identical unfinished Paddle event", async () => {
    const payload = eventPayload("evt_payload_refresh", "customer.updated", {
      id: "ctm_refresh1",
      email: "refresh@example.test",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    });
    const first = await postEvent(payload);
    testEnv.sqliteDb.prepare(
      `UPDATE inbound_events
       SET status = 'needs_attention', payload_expires_at = '2026-09-18T00:00:00.000Z',
           last_error_code = 'BILLING_EVENT_PAYLOAD_EXPIRED',
           last_error_detail = '{"message":"expired"}'
       WHERE id = ?`,
    ).run(first.body.data.event_id);
    await expect(clearExpiredInboundEventPayloads(testEnv.d1, {
      now: new Date("2026-09-19T08:01:00.000Z"),
    })).resolves.toEqual({ cleared: 1 });
    expect(testEnv.sqliteDb.prepare(
      "SELECT payload_ciphertext, payload_cleared_at FROM inbound_events WHERE id = ?",
    ).get(first.body.data.event_id)).toEqual({
      payload_ciphertext: null,
      payload_cleared_at: "2026-09-19T08:01:00.000Z",
    });

    const replay = await postEvent(payload);
    expect(replay.response.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      event_id: first.body.data.event_id,
      duplicate: true,
      payload_refreshed: true,
      status: "needs_attention",
    });
    const refreshed = testEnv.sqliteDb.prepare(
      `SELECT status, payload_ciphertext, payload_expires_at, payload_cleared_at, last_error_code
       FROM inbound_events WHERE id = ?`,
    ).get(first.body.data.event_id) as any;
    expect(refreshed.status).toBe("needs_attention");
    expect(refreshed.payload_ciphertext).toBeTruthy();
    expect(Date.parse(refreshed.payload_expires_at)).toBeGreaterThan(Date.now());
    expect(refreshed.payload_cleared_at).toBeNull();
    expect(refreshed.last_error_code).toBe("BILLING_EVENT_PAYLOAD_EXPIRED");
  });

  it("keeps an out-of-order subscription purchase pending, then fulfills once trusted dependencies arrive", async () => {
    testEnv.sqliteDb.prepare(
      `INSERT INTO products (
         id, instance_id, name, payment_grace_seconds,
         status, created_at, updated_at
       ) VALUES ('prd_00000000000000000000000002', ?, 'Subscription',
         86400, 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         payment_grace_seconds, features_json, status, created_at, updated_at
       ) VALUES ('pln_sub', ?, 'prd_00000000000000000000000002', 'Subscription', 'subscription', 'opaque',
         86400, '[]', 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_offers (
         id, instance_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_sub', ?, ?, 'pri_sub123', 'prd_00000000000000000000000002', 'pln_sub',
         'subscription', 'active', ?, ?)`,
    ).run(instanceId, providerId, nowIso, nowIso);

    const transaction = await postEvent(eventPayload("evt_txn_early", "transaction.completed", {
      id: "txn_early1",
      customer_id: "ctm_early1",
      subscription_id: "sub_early1",
      items: [{ price: { id: "pri_sub123" }, quantity: 1 }],
    }));
    expect((await processEvent(transaction.body.data.event_id)).status).toBe("pending");
    expect((testEnv.sqliteDb.prepare("SELECT last_error_code FROM inbound_events WHERE id = ?")
      .get(transaction.body.data.event_id) as any).last_error_code).toBe("BILLING_DEPENDENCY_PENDING");

    const customer = await postEvent(eventPayload("evt_customer_early", "customer.created", {
      id: "ctm_early1",
      email: "early@example.test",
      name: "Early Buyer",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    }));
    expect((await processEvent(customer.body.data.event_id)).status).toBe("processed");

    const subscription = await postEvent(eventPayload("evt_sub_early", "subscription.created", {
      id: "sub_early1",
      transaction_id: "txn_early1",
      customer_id: "ctm_early1",
      status: "active",
      current_billing_period: {
        starts_at: "2026-09-19T08:00:00.000Z",
        ends_at: "2026-10-19T08:00:00.000Z",
      },
      next_billed_at: "2026-10-19T08:00:00.000Z",
      items: [{ price: { id: "pri_sub123" }, quantity: 1 }],
    }));
    expect((await processEvent(subscription.body.data.event_id)).status).toBe("processed");
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM licenses WHERE source_external_transaction_id = 'txn_early1'").get())
      .toEqual({ count: 1 });
    expect((testEnv.sqliteDb.prepare("SELECT status, external_subscription_id FROM billing_subscriptions").get() as any))
      .toMatchObject({ status: "active", external_subscription_id: "sub_early1" });
  });

  it.each([
    ["unknown price", [{ price: { id: "pri_unknown1" }, quantity: 1 }], "BILLING_OFFER_MAPPING_MISSING"],
    ["multiple lines", [
      { price: { id: "pri_one123" }, quantity: 1 },
      { price: { id: "pri_unknown2" }, quantity: 1 },
    ], "BILLING_TRANSACTION_ITEMS_UNSUPPORTED"],
    ["quantity greater than one", [{ price: { id: "pri_one123" }, quantity: 2 }], "BILLING_TRANSACTION_ITEMS_UNSUPPORTED"],
  ])("moves an unsupported %s purchase to needs_attention", async (_name, items, errorCode) => {
    seedLinkedCustomer();
    const id = `txn_bad_${String(errorCode).toLowerCase()}_${items.length}`;
    const posted = await postEvent(eventPayload(`evt_${id}`, "transaction.completed", {
      id,
      customer_id: "ctm_buyer1",
      items,
    }));
    const result = await processEvent(posted.body.data.event_id);
    expect(result.status).toBe("needs_attention");
    expect((testEnv.sqliteDb.prepare("SELECT last_error_code FROM inbound_events WHERE id = ?")
      .get(posted.body.data.event_id) as any).last_error_code).toBe(errorCode);
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM licenses").get()).toEqual({ count: 0 });
  });

  it("persists exact approved full-refund semantics and suspends without revoking activations", async () => {
    seedLinkedCustomer();
    const { licenseId } = await issueOneTimeLicense("txn_refund1");
    testEnv.sqliteDb.prepare(
      `INSERT INTO activations (
         id, instance_id, license_id, fingerprint_hash, machine_token_hash,
         status, activated_at, updated_at
       ) VALUES ('act_refund', ?, ?, 'fp_refund', 'mt_refund', 'active', ?, ?)`,
    ).run(instanceId, licenseId, nowIso, nowIso);
    const adjustment = await postEvent(eventPayload("evt_adj_refund", "adjustment.updated", {
      id: "adj_refund1",
      transaction_id: "txn_refund1",
      customer_id: "ctm_buyer1",
      action: "refund",
      type: "full",
      status: "approved",
      currency_code: "USD",
      total: "1000",
      reason: "requested_by_customer",
    }, "2026-09-19T09:00:00.000Z"));
    expect((await processEvent(adjustment.body.data.event_id)).status).toBe("needs_attention");
    expect(testEnv.sqliteDb.prepare(
      `SELECT provider_action, adjustment_type, provider_status, automatic_effect, review_status
       FROM billing_adjustments WHERE external_adjustment_id = 'adj_refund1'`,
    ).get()).toEqual({
      provider_action: "refund",
      adjustment_type: "full",
      provider_status: "approved",
      automatic_effect: "license_suspended",
      review_status: "open",
    });
    expect(testEnv.sqliteDb.prepare("SELECT status, status_reason FROM licenses WHERE id = ?").get(licenseId))
      .toEqual({ status: "suspended", status_reason: "billing_adjustment" });
    expect(testEnv.sqliteDb.prepare("SELECT status FROM activations WHERE id = 'act_refund'").get())
      .toEqual({ status: "active" });
  });

  it("commits fulfillment before immediately dispatching the typed License email", async () => {
    seedLinkedCustomer();
    await configureLicenseIssuedEmail();
    const providerBodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      providerBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ id: "email_billing_license_issued" }),
        {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-request-id": "request_billing_license_issued",
          },
        },
      );
    }));

    const { licenseId } = await issueOneTimeLicense("txn_email_fulfillment");

    expect(providerBodies).toHaveLength(1);
    expect(providerBodies[0]).toMatchObject({
      to: "buyer@example.test",
      template: {
        id: "license-issued-v1",
        variables: {
          instance_name: "Billing V1",
          product_id: "prd_00000000000000000000000001",
          product_name: "One Time (Sandbox)",
          license_id: licenseId,
          license_model: "perpetual",
        },
      },
    });
    expect(Object.keys(providerBodies[0].template.variables).sort()).toEqual([
      "instance_name",
      "license_id",
      "license_key",
      "license_model",
      "product_id",
      "product_name",
    ]);
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, notification_type, provider_message_id
       FROM email_deliveries
       WHERE instance_id = ? AND notification_type = 'customer.license_issued'`,
    ).get(instanceId)).toEqual({
      status: "accepted",
      notification_type: "customer.license_issued",
      provider_message_id: "email_billing_license_issued",
    });
  });

  it("does not expose a LicenKit public Checkout configuration endpoint", async () => {
    const response = await app.request(
      "/api/v1/public/instances/billing-v1/products/one/checkout",
      { method: "GET" },
      testEnv.env,
    );

    expect(response.status).toBe(404);
  });

  it("does not require removed Checkout SDK PricePreview evidence for a Live Offer", async () => {
    const liveProviderId = "bpr_live_readiness";
    const encryptedSecret = await encryptBillingProviderSecret(
      webhookSecret,
      testEnv.env,
      instanceId,
      liveProviderId,
      "webhook_secret_ciphertext",
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_providers (
         id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'live', 'live_client_token_v1', ?, 'active', ?, ?)`,
    ).run(liveProviderId, instanceId, encryptedSecret, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO products (
         id, instance_id, name, status, created_at, updated_at
       ) VALUES ('prd_live_readiness', ?, 'Live Readiness', 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         payment_grace_seconds, features_json, status, created_at, updated_at
       ) VALUES ('pln_live_readiness', ?, 'prd_live_readiness', 'Live Readiness', 'perpetual', 'opaque',
         0, '[]', 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_offers (
         id, instance_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_live_readiness', ?, ?, 'pri_live_readiness', 'prd_live_readiness',
         'pln_live_readiness', 'one_time', 'draft', ?, ?)`,
    ).run(instanceId, liveProviderId, nowIso, nowIso);
    const row = await getBillingOfferReadinessRow(testEnv.env.DB, instanceId, "off_live_readiness");
    expect(row).not.toBeNull();

    const readiness = await evaluateBillingOfferReadiness(testEnv.env.DB, row!, {
      env: testEnv.env,
      activation: true,
    });

    expect(readiness.checks.map((item) => item.key)).not.toContain("live_price_preview");
  });

  it("selects only Instances with due Billing work and still reaches a late Instance", async () => {
    const db = testEnv.sqliteDb;
    const insertInstance = db.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES (?, ?, 'https://licenses.example.test', ?, 'active', ?, ?)`,
    );
    for (let index = 0; index < 105; index++) {
      const suffix = String(index).padStart(3, "0");
      insertInstance.run(
        `acc_page_${suffix}`,
        `Page ${suffix}`,
        `https://license-page-${suffix}.example.test`,
        nowIso,
        nowIso,
      );
    }
    const lateInstanceId = "acc_page_104";
    const lateProviderId = "bpr_page_104";
    const encryptedSecret = await encryptBillingProviderSecret(
      webhookSecret,
      testEnv.env,
      lateInstanceId,
      lateProviderId,
      "webhook_secret_ciphertext",
    );
    db.prepare(
      `INSERT INTO billing_providers (
         id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'sandbox', 'test_page_token', ?, 'active', ?, ?)`,
    ).run(lateProviderId, lateInstanceId, encryptedSecret, nowIso, nowIso);
    const eventId = "ine_last_page";
    const rawBody = eventPayload("evt_last_page", "product.updated", { id: "pro_lastpage" });
    const payloadCiphertext = await encryptInboundPayload(
      rawBody,
      testEnv.env,
      lateInstanceId,
      eventId,
    );
    const scheduleNow = new Date(Date.now() + 1_000);
    db.prepare(
      `INSERT INTO inbound_events (
         id, instance_id, billing_provider_id, external_event_id, external_event_type,
         payload_ciphertext, payload_hash, payload_expires_at, status, attempt_count,
         next_attempt_at, received_at, updated_at
       ) VALUES (?, ?, ?, 'evt_last_page', 'product.updated', ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).run(
      eventId,
      lateInstanceId,
      lateProviderId,
      payloadCiphertext,
      await sha256Hex(rawBody),
      new Date(scheduleNow.getTime() + 86_400_000).toISOString(),
      nowIso,
      nowIso,
      nowIso,
    );
    const result = await processDueBillingInboundEvents(testEnv.env, {
      instanceLimit: 25,
      eventLimitPerInstance: 5,
      now: scheduleNow,
      workerId: "scheduler_pagination_test",
    });
    expect(result.instances).toBe(1);
    expect(result.processed).toBe(1);
    expect(db.prepare("SELECT status, result_type FROM inbound_events WHERE id = ?").get(eventId))
      .toEqual({ status: "processed", result_type: "ignored_event_type" });
  });

  it("consumes a Sandbox verification token once and creates only a permanently suspended evidence License", async () => {
    seedLinkedCustomer();
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES ('usr_verify', 'admin@example.test', 'hash', 'Admin', ?, ?)`,
    ).run(nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      "UPDATE billing_offers SET status = 'draft' WHERE id = 'off_one'",
    ).run();
    const token = "vfy_single_use_token";
    const verificationExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_checkout_verifications (
         id, instance_id, billing_offer_id, requested_by_user_id, token_hash,
         status, expires_at, created_at, updated_at
       ) VALUES ('bcv_one', ?, 'off_one', 'usr_verify', ?, 'pending', ?, ?, ?)`,
    ).run(instanceId, await sha256Hex(token), verificationExpiresAt, nowIso, nowIso);
    const first = await postEvent(eventPayload("evt_verify_one", "transaction.completed", {
      id: "txn_verify1",
      customer_id: "ctm_buyer1",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
      custom_data: { licenkit_checkout_verification: token },
    }));
    expect((await processEvent(first.body.data.event_id)).status).toBe("processed");
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, status_reason, is_checkout_verification
       FROM licenses WHERE source_external_transaction_id = 'txn_verify1'`,
    ).get()).toEqual({ status: "suspended", status_reason: "checkout_verification", is_checkout_verification: 1 });
    expect((testEnv.sqliteDb.prepare("SELECT status FROM billing_checkout_verifications WHERE id = 'bcv_one'").get() as any).status)
      .toBe("delivery_pending");

    const replay = await postEvent(eventPayload("evt_verify_reuse", "transaction.completed", {
      id: "txn_verify2",
      customer_id: "ctm_buyer1",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
      custom_data: { licenkit_checkout_verification: token },
    }));
    expect((await processEvent(replay.body.data.event_id)).status).toBe("needs_attention");
    expect((testEnv.sqliteDb.prepare("SELECT last_error_code FROM inbound_events WHERE id = ?")
      .get(replay.body.data.event_id) as any).last_error_code).toBe("BILLING_CHECKOUT_VERIFICATION_INVALID");
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM licenses").get()).toEqual({ count: 1 });

    const pendingDelivery = testEnv.sqliteDb.prepare(
      "SELECT delivery_id FROM billing_checkout_verifications WHERE id = 'bcv_one'",
    ).get() as { delivery_id: string };
    const csrfToken = "acf_checkout_cancel_test_token";
    const emailAdmin = new Hono<AppContext>();
    emailAdmin.onError(errorHandler);
    emailAdmin.use("*", async (c, next) => {
      c.set("requestId", "req_checkout_cancel");
      c.set("instanceId", instanceId);
      c.set("userId", "usr_verify");
      c.set("instanceRole", "owner");
      c.set("userEmail", "admin@example.test");
      c.set("sessionNamespace", "admin");
      c.set("sessionCsrfTokenHash", await sha256Hex(csrfToken));
      await next();
    });
    emailAdmin.route("/email-deliveries", adminEmailDeliveriesRouter);
    const cancelled = await emailAdmin.request(
      `https://licenses.example.test/email-deliveries/${pendingDelivery.delivery_id}/cancel`,
      {
        method: "POST",
        headers: {
          Origin: "https://licenses.example.test",
          "X-CSRF-Token": csrfToken,
          Cookie: `__Host-licenkit-admin-csrf=${csrfToken}`,
        },
      },
      testEnv.env,
    );
    expect(cancelled.status).toBe(200);
    expect(testEnv.sqliteDb.prepare(
      "SELECT status FROM billing_checkout_verifications WHERE id = 'bcv_one'",
    ).get()).toEqual({ status: "cancelled" });

    await configureLicenseIssuedEmail();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ id: "email_checkout_verification_accepted" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const acceptedToken = "vfy_delivery_accepted_token";
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_checkout_verifications (
         id, instance_id, billing_offer_id, requested_by_user_id, token_hash,
         status, expires_at, created_at, updated_at
       ) VALUES ('bcv_accepted', ?, 'off_one', 'usr_verify', ?, 'pending', ?, ?, ?)`,
    ).run(
      instanceId,
      await sha256Hex(acceptedToken),
      verificationExpiresAt,
      nowIso,
      nowIso,
    );
    const acceptedEvent = await postEvent(eventPayload(
      "evt_verify_accepted",
      "transaction.completed",
      {
        id: "txn_verify_accepted",
        customer_id: "ctm_buyer1",
        items: [{ price: { id: "pri_one123" }, quantity: 1 }],
        custom_data: { licenkit_checkout_verification: acceptedToken },
      },
    ));
    expect((await processEvent(acceptedEvent.body.data.event_id)).status).toBe("processed");
    expect(testEnv.sqliteDb.prepare(
      `SELECT verification.status AS verification_status,
              delivery.status AS delivery_status
       FROM billing_checkout_verifications AS verification
       JOIN email_deliveries AS delivery ON delivery.id = verification.delivery_id
       WHERE verification.id = 'bcv_accepted'`,
    ).get()).toEqual({
      verification_status: "completed",
      delivery_status: "accepted",
    });

    const liveProviderId = "bpr_live_v1";
    const liveSecret = "pdl_ntfsec_live_test_secret_123456789";
    const encryptedLiveSecret = await encryptBillingProviderSecret(
      liveSecret,
      testEnv.env,
      instanceId,
      liveProviderId,
      "webhook_secret_ciphertext",
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_providers (
         id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'live', 'live_client_token_v1', ?, 'active', ?, ?)`,
    ).run(liveProviderId, instanceId, encryptedLiveSecret, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_offers (
         id, instance_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_live_verify', ?, ?, 'pri_live123', 'prd_00000000000000000000000001', 'pln_one',
         'one_time', 'draft', ?, ?)`,
    ).run(instanceId, liveProviderId, nowIso, nowIso);
    const liveToken = "vfy_live_must_not_work";
    const liveTokenHash = await sha256Hex(liveToken);
    expect(() => testEnv.sqliteDb.prepare(
      `INSERT INTO billing_checkout_verifications (
         id, instance_id, billing_offer_id, requested_by_user_id, token_hash,
         status, expires_at, created_at, updated_at
       ) VALUES ('bcv_live', ?, 'off_live_verify', 'usr_verify', ?, 'pending',
         '2026-09-20T08:00:00.000Z', ?, ?)`,
    ).run(instanceId, liveTokenHash, nowIso, nowIso)).toThrow(/draft_sandbox_offer/);
  });
  it("keeps Provider auth failures as passive issues while Events remain independently actionable", async () => {
    await configureProviderApiKey();
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "authentication_error", detail: "API key lacks customer.read" },
      meta: { request_id: "req_auth_failure" },
    }), {
      status: 403,
      headers: { "content-type": "application/json", "request-id": "req_auth_failure" },
    }));
    vi.stubGlobal("fetch", providerFetch);

    const first = await postEvent(eventPayload("evt_auth_attention_one", "transaction.completed", {
      id: "txn_auth_attention_one",
      customer_id: "ctm_authone",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
    }));
    const second = await postEvent(eventPayload("evt_auth_attention_two", "transaction.completed", {
      id: "txn_auth_attention_two",
      customer_id: "ctm_authtwo",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
    }));

    expect((await processEvent(first.body.data.event_id)).status).toBe("needs_attention");
    expect((await processEvent(second.body.data.event_id)).status).toBe("needs_attention");

    const issues = testEnv.sqliteDb.prepare(
      `SELECT id, category, source_type, source_id, operation, error_code,
              error_detail_json, occurrence_count
       FROM system_issues
       WHERE instance_id = ?`,
    ).all(instanceId) as Array<any>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "webhook",
      source_type: "billing_provider",
      source_id: providerId,
      operation: "customer_read",
      error_code: "BILLING_PROVIDER_API_AUTH_INVALID",
      occurrence_count: 2,
    });
    expect(JSON.parse(issues[0].error_detail_json)).toMatchObject({
      httpStatus: 403,
      providerCode: "authentication_error",
      requestId: "req_auth_failure",
      message: "API key lacks customer.read",
    });

    const listed = await listSystemIssues({ db: testEnv.d1, instanceId });
    expect(listed.items).toEqual([
      expect.objectContaining({
        id: issues[0].id,
        category: "webhook",
        sourceType: "billing_provider",
        sourceId: providerId,
        operation: "customer_read",
        errorCode: "BILLING_PROVIDER_API_AUTH_INVALID",
        occurrenceCount: 2,
      }),
    ]);

    const events = testEnv.sqliteDb.prepare(
      `SELECT status, next_attempt_at, last_error_code, last_error_detail
       FROM inbound_events
       WHERE id IN (?, ?)
       ORDER BY id`,
    ).all(first.body.data.event_id, second.body.data.event_id) as Array<any>;
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        status: "needs_attention",
        next_attempt_at: null,
        last_error_code: "BILLING_PROVIDER_API_AUTH_INVALID",
      });
      expect(JSON.parse(event.last_error_detail)).toMatchObject({
        httpStatus: 403,
        providerCode: "authentication_error",
        requestId: "req_auth_failure",
      });
    }

    const skipped = await processDueBillingInboundEvents(testEnv.env, {
      now: new Date(Date.now() + 5_000),
      workerId: "attention_scheduler",
    });
    expect(skipped.claimed).toBe(0);
    expect(providerFetch).toHaveBeenCalledTimes(2);

    const customerWebhook = await postEvent(eventPayload("evt_customer_after_auth_error", "customer.updated", {
      id: "ctm_authone",
      email: "mapped-one@example.test",
      name: "Mapped One",
      status: "active",
      created_at: nowIso,
      updated_at: "2026-09-19T08:01:00.000Z",
    }));
    expect((await processEvent(customerWebhook.body.data.event_id)).status).toBe("processed");
    expect(testEnv.sqliteDb.prepare(
      "SELECT status FROM inbound_events WHERE id = ?",
    ).get(first.body.data.event_id)).toEqual({ status: "needs_attention" });
  });

  it("records manual billing API failures without creating or linking an inbound Event", async () => {
    await configureProviderApiKey();
    seedLinkedCustomer("ctm_reconcile1", "reconcile@example.test");
    const rejected = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "authentication_error", detail: "Key is not authorized" },
    }), {
      status: 401,
      headers: { "content-type": "application/json", "request-id": "req_reconcile_auth" },
    }));

    await expect(reconcileBillingCustomer({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      billingCustomerId: "bcu_buyer",
      fetchImpl: rejected as typeof fetch,
      now: new Date(Date.now() + 1_000),
    })).rejects.toMatchObject({ code: "BILLING_PROVIDER_API_AUTH_INVALID" });

    expect(testEnv.sqliteDb.prepare(
      `SELECT category, source_type, source_id, operation, error_code, occurrence_count
       FROM system_issues WHERE instance_id = ?`,
    ).get(instanceId)).toEqual({
      category: "billing",
      source_type: "billing_provider",
      source_id: providerId,
      operation: "customer_read",
      error_code: "BILLING_PROVIDER_API_AUTH_INVALID",
      occurrence_count: 1,
    });
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM inbound_events").get())
      .toEqual({ count: 0 });
  });

  it("records a customer portal API failure as a passive billing issue", async () => {
    await configureProviderApiKey();
    seedLinkedCustomer("ctm_portal1", "portal@example.test");
    testEnv.sqliteDb.prepare(
      `INSERT INTO products (
         id, instance_id, name, payment_grace_seconds,
         status, created_at, updated_at
       ) VALUES ('prd_portal', ?, 'Portal Subscription', 86400,
         'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO license_plans (
         id, instance_id, product_id, name, license_model, credential_mode,
         payment_grace_seconds, features_json, status, created_at, updated_at
       ) VALUES ('pln_portal', ?, 'prd_portal', 'Portal Subscription', 'subscription', 'opaque',
         86400, '[]', 'active', ?, ?)`,
    ).run(instanceId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO licenses (
         id, instance_id, customer_id, product_id, plan_id, plan_revision,
         license_model, renewal_mode, credential_mode, offline_grace_seconds,
         payment_grace_seconds, max_activations, features_json, key_hash,
         key_version, source, billing_environment, source_billing_provider_id,
         source_external_transaction_id, status, expires_at, created_at, updated_at
       ) VALUES (
         'lic_portal1', ?, 'cus_buyer', 'prd_portal', 'pln_portal', 1,
         'subscription', 'billing', 'opaque', 2592000,
         86400, 1, '[]', 'portal-key-hash',
         1, 'payment', 'sandbox', ?, 'txn_portal1', 'active',
         '2026-10-19T08:00:00.000Z', ?, ?
       )`,
    ).run(instanceId, providerId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_subscriptions (
         id, instance_id, billing_provider_id, license_id,
         external_subscription_id, external_customer_id, external_price_id,
         status, current_period_start, current_period_end, next_billed_at,
         created_at, updated_at
       ) VALUES (
         'bsub_portal1', ?, ?, 'lic_portal1',
         'sub_portal1', 'ctm_portal1', 'pri_portal1',
         'active', ?, '2026-10-19T08:00:00.000Z', '2026-10-19T08:00:00.000Z',
         ?, ?
       )`,
    ).run(instanceId, providerId, nowIso, nowIso, nowIso);

    const rejected = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "forbidden", detail: "customer_portal_session.write is missing" },
    }), {
      status: 403,
      headers: { "content-type": "application/json", "request-id": "req_portal_forbidden" },
    }));
    await expect(createCustomerPortalSession({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      customerId: "cus_buyer",
      licenseId: "lic_portal1",
      fetchImpl: rejected as typeof fetch,
      now: new Date(Date.now() + 1_000),
    })).rejects.toMatchObject({ code: "BILLING_PROVIDER_API_AUTH_INVALID", status: 502 });

    expect(testEnv.sqliteDb.prepare(
      `SELECT category, source_type, source_id, operation, error_code, occurrence_count
       FROM system_issues WHERE instance_id = ?`,
    ).get(instanceId)).toEqual({
      category: "billing",
      source_type: "billing_provider",
      source_id: providerId,
      operation: "customer_portal_session",
      error_code: "BILLING_PROVIDER_API_AUTH_INVALID",
      occurrence_count: 1,
    });
  });
});
