import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { dispatchDelivery, testEmailConfiguration } from "../src/infra/delivery/dispatcher";
import { prepareEmailNotificationDelivery } from "../src/services/delivery/outbox";
import { clearExpiredAcceptedEmailPayloads } from "../src/services/delivery/retention";
import { runDeliveryScheduler } from "../src/services/delivery/scheduler";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const NOW = new Date("2026-09-20T10:00:00.000Z");
const INSTANCE_ID = "acc_email_core";
const CUSTOMER_ID = "cus_email_core";
const INTEGRATION_ID = "emi_email_core";
const BINDING_ID = "etb_email_core";
const NOTIFICATION_TYPE = "customer.license_issued";

const BUSINESS_VARIABLES = Object.freeze({
  product_id: "prd_00000000000000000000000000",
  product_name: "Example App",
  license_id: "lic_00000000000000000000000000",
  license_key: "LK-000000-000000-000000-000000-00",
  license_model: "subscription",
  expires_at: "2026-10-19T10:00:00.000Z",
});

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("email-only Delivery core", () => {
  let testEnv: TestEnvContext;

  beforeEach(async () => {
    testEnv = createTestEnv({ STORAGE_ENCRYPTION_KEY_ID: "test-primary" });
    const nowIso = NOW.toISOString();
    testEnv.sqliteDb.prepare(
      `INSERT INTO instances (id, name, slug, site_url, admin_api_url, status, created_at, updated_at)
       VALUES (?, 'Core Instance', 'core-instance', 'https://site.example.test', 'https://license.example.test', 'active', ?, ?)`,
    ).run(INSTANCE_ID, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO customers (id, instance_id, email, name, status, created_at, updated_at)
       VALUES (?, ?, 'buyer@example.test', 'Buyer', 'active', ?, ?)`,
    ).run(CUSTOMER_ID, INSTANCE_ID, nowIso, nowIso);
    const credentialCiphertext = await encryptEnvelopeV1(
      JSON.stringify({ version: 1, apiKey: "re_email_core_secret" }),
      testEnv.env,
      { instanceId: INSTANCE_ID, table: "email_integrations", rowId: INTEGRATION_ID, field: "credential_ciphertext" },
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO email_integrations (
         id, instance_id, provider, name, credential_ciphertext,
         default_from_email, default_from_name, reply_to_email,
         max_automatic_attempts, status, created_at, updated_at
       ) VALUES (?, ?, 'resend', 'Primary', ?, 'licenses@example.test',
         'Core Licenses', 'support@example.test', 4, 'active', ?, ?)`,
    ).run(INTEGRATION_ID, INSTANCE_ID, credentialCiphertext, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO email_template_bindings (
         id, instance_id, email_integration_id, notification_type,
         contract_version, provider_template_ref, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'license-issued-v1', 'active', ?, ?)`,
    ).run(BINDING_ID, INSTANCE_ID, INTEGRATION_ID, NOTIFICATION_TYPE, nowIso, nowIso);
  });

  async function prepareBusinessDelivery(sendExpiresAt?: string) {
    const prepared = await prepareEmailNotificationDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
      customerId: CUSTOMER_ID,
      notificationType: NOTIFICATION_TYPE,
      contractVersion: 1,
      recipientEmail: "buyer@example.test",
      variables: BUSINESS_VARIABLES,
      ...(sendExpiresAt ? { sendExpiresAt } : {}),
      now: NOW,
    });
    await testEnv.d1.batch(prepared.statements);
    return prepared;
  }

  it("sends a configuration test directly without persisting a Delivery", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      jsonResponse({ id: "email_test" }, { headers: { "x-request-id": "req_test" } }),
    ) as unknown as typeof fetch;
    const result = await testEmailConfiguration({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
      emailIntegrationId: INTEGRATION_ID,
      notificationType: NOTIFICATION_TYPE,
      contractVersion: 1,
      recipientEmail: "operator@example.test",
      fetchImpl,
    });
    expect(result).toMatchObject({
      providerAccepted: true,
      providerMessageId: "email_test",
      recipientEmail: "operator@example.test",
    });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM email_deliveries").get()).toEqual({ count: 0 });
    const request = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      from: "Core Licenses <licenses@example.test>",
      to: "operator@example.test",
      template: { id: "license-issued-v1", variables: { instance_name: "Core Instance" } },
    });
  });

  it("stores only encrypted event variables and uses the latest configuration when sending", async () => {
    const prepared = await prepareBusinessDelivery();
    const stored = testEnv.sqliteDb.prepare(
      "SELECT recipient_type, customer_id, variables_ciphertext FROM email_deliveries WHERE id = ?",
    ).get(prepared.deliveryId) as any;
    expect(stored.recipient_type).toBe("customer");
    expect(stored.customer_id).toBe(CUSTOMER_ID);
    const variables = JSON.parse(await decryptEnvelopeV1(stored.variables_ciphertext, testEnv.env, {
      instanceId: INSTANCE_ID,
      table: "email_deliveries",
      rowId: prepared.deliveryId,
      field: "variables_ciphertext",
    }));
    expect(variables).toMatchObject({ instance_name: "Core Instance", license_key: BUSINESS_VARIABLES.license_key });
    expect(variables).not.toHaveProperty("recipient_email");
    expect(variables).not.toHaveProperty("provider");
    expect(variables).not.toHaveProperty("provider_template_ref");

    testEnv.sqliteDb.prepare(
      `UPDATE email_integrations SET default_from_name = 'Latest Sender', updated_at = ? WHERE id = ?`,
    ).run("2026-09-20T10:00:01.000Z", INTEGRATION_ID);
    testEnv.sqliteDb.prepare(
      `UPDATE email_template_bindings SET provider_template_ref = 'license-issued-latest', updated_at = ? WHERE id = ?`,
    ).run("2026-09-20T10:00:01.000Z", BINDING_ID);
    // The stored version describes the event-time variable contract. Sending
    // resolves the current Binding (including its current contract version).
    testEnv.sqliteDb.prepare(
      "UPDATE email_deliveries SET contract_version = 99 WHERE id = ?",
    ).run(prepared.deliveryId);
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "email_latest" })) as unknown as typeof fetch;
    await expect(dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
      deliveryId: prepared.deliveryId,
      fetchImpl,
      now: NOW,
    })).resolves.toMatchObject({ status: "accepted", attemptNumber: 1 });
    const request = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      from: "Latest Sender <licenses@example.test>",
      template: { id: "license-issued-latest" },
    });
    const accepted = testEnv.sqliteDb.prepare(
      "SELECT status, attempt_count, variables_ciphertext, variables_expires_at, provider_message_id FROM email_deliveries WHERE id = ?",
    ).get(prepared.deliveryId) as any;
    expect(accepted).toMatchObject({
      status: "accepted",
      attempt_count: 1,
      provider_message_id: "email_latest",
      variables_expires_at: "2026-09-21T10:00:00.000Z",
    });
    expect(accepted.variables_ciphertext).toBeTruthy();
  });

  it("does not call Provider or consume an attempt when stored variables no longer satisfy the code contract", async () => {
    const prepared = await prepareBusinessDelivery();
    const invalidCiphertext = await encryptEnvelopeV1(JSON.stringify({
      instance_name: "Core Instance",
      product_id: BUSINESS_VARIABLES.product_id,
    }), testEnv.env, {
      instanceId: INSTANCE_ID,
      table: "email_deliveries",
      rowId: prepared.deliveryId,
      field: "variables_ciphertext",
    });
    testEnv.sqliteDb.prepare("UPDATE email_deliveries SET variables_ciphertext = ? WHERE id = ?").run(invalidCiphertext, prepared.deliveryId);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(dispatchDelivery({ db: testEnv.d1, env: testEnv.env, instanceId: INSTANCE_ID, deliveryId: prepared.deliveryId, fetchImpl, now: NOW }))
      .resolves.toMatchObject({ status: "waiting_configuration", errorCode: "EMAIL_CONTRACT_VARIABLE_REQUIRED" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const row = testEnv.sqliteDb.prepare("SELECT status, attempt_count, last_error_json FROM email_deliveries WHERE id = ?").get(prepared.deliveryId) as any;
    expect(row.status).toBe("waiting_configuration");
    expect(row.attempt_count).toBe(0);
    expect(JSON.parse(row.last_error_json)).toMatchObject({ code: "EMAIL_CONTRACT_VARIABLE_REQUIRED" });
  });

  it("retries only a definitive retryable response and rematerializes the latest request", async () => {
    const prepared = await prepareBusinessDelivery();
    const calls: Array<{ headers: Headers; body: any }> = [];
    const responses = [
      jsonResponse({ name: "rate_limit_exceeded", code: "provider_throttle", message: "Too many requests." }, { status: 429, headers: { "retry-after": "1" } }),
      jsonResponse({ id: "email_after_retry" }),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return responses.shift()!;
    }) as unknown as typeof fetch;
    await expect(dispatchDelivery({ db: testEnv.d1, env: testEnv.env, instanceId: INSTANCE_ID, deliveryId: prepared.deliveryId, fetchImpl, now: NOW }))
      .resolves.toMatchObject({ status: "retry_scheduled", attemptNumber: 1 });
    testEnv.sqliteDb.prepare("UPDATE email_integrations SET default_from_name = 'Retry Sender' WHERE id = ?").run(INTEGRATION_ID);
    testEnv.sqliteDb.prepare("UPDATE email_template_bindings SET provider_template_ref = 'retry-template-v2' WHERE id = ?").run(BINDING_ID);
    const retryNow = new Date("2026-09-20T10:01:00.000Z");
    await expect(dispatchDelivery({ db: testEnv.d1, env: testEnv.env, instanceId: INSTANCE_ID, deliveryId: prepared.deliveryId, fetchImpl, now: retryNow }))
      .resolves.toMatchObject({ status: "accepted", attemptNumber: 2 });
    expect(calls[1].body).toMatchObject({ from: "Retry Sender <licenses@example.test>", template: { id: "retry-template-v2" } });
    expect(calls[1].headers.get("idempotency-key")).not.toBe(calls[0].headers.get("idempotency-key"));
  });

  it("does not automatically retry an unknown Provider result", async () => {
    const prepared = await prepareBusinessDelivery();
    const fetchImpl = vi.fn(async () => { throw new TypeError("network reset"); }) as unknown as typeof fetch;
    await expect(dispatchDelivery({ db: testEnv.d1, env: testEnv.env, instanceId: INSTANCE_ID, deliveryId: prepared.deliveryId, fetchImpl, now: NOW }))
      .resolves.toMatchObject({ status: "failed", attemptNumber: 1, outcomeUnknown: true });
    const row = testEnv.sqliteDb.prepare("SELECT status, next_attempt_at, last_error_json FROM email_deliveries WHERE id = ?").get(prepared.deliveryId) as any;
    expect(row.status).toBe("failed");
    expect(row.next_attempt_at).toBeNull();
    expect(JSON.parse(row.last_error_json)).toMatchObject({ outcome: "provider_result_unknown", possible_duplicate_on_resend: true });
    await runDeliveryScheduler({ ...testEnv.env, DB: testEnv.d1 }, { now: new Date("2026-09-20T11:00:00.000Z") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary business variables retryable until Provider acceptance", async () => {
    const prepared = await prepareBusinessDelivery();
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "email_late_manual_retry" })) as unknown as typeof fetch;
    await expect(dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
      deliveryId: prepared.deliveryId,
      fetchImpl,
      now: new Date("2026-09-22T10:00:00.000Z"),
    })).resolves.toMatchObject({ status: "accepted" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const stored = testEnv.sqliteDb.prepare(
      "SELECT status, variables_ciphertext, variables_expires_at FROM email_deliveries WHERE id = ?",
    ).get(prepared.deliveryId) as any;
    expect(stored.status).toBe("accepted");
    expect(stored.variables_ciphertext).toBeTruthy();
    expect(stored.variables_expires_at).toBe("2026-09-23T10:00:00.000Z");
  });

  it("starts sensitive-variable cleanup only after Provider acceptance", async () => {
    const prepared = await prepareBusinessDelivery();
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "email_retention" })) as unknown as typeof fetch;
    await dispatchDelivery({
      db: testEnv.d1,
      env: { ...testEnv.env, SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS: 60 },
      instanceId: INSTANCE_ID,
      deliveryId: prepared.deliveryId,
      fetchImpl,
      now: NOW,
    });

    await expect(clearExpiredAcceptedEmailPayloads(
      testEnv.d1,
      new Date("2026-09-20T10:00:59.999Z"),
    )).resolves.toBe(0);
    expect(testEnv.sqliteDb.prepare(
      "SELECT variables_ciphertext FROM email_deliveries WHERE id = ?",
    ).get(prepared.deliveryId)).toMatchObject({ variables_ciphertext: expect.any(String) });

    await expect(clearExpiredAcceptedEmailPayloads(
      testEnv.d1,
      new Date("2026-09-20T10:01:00.000Z"),
    )).resolves.toBe(1);
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, variables_ciphertext FROM email_deliveries WHERE id = ?",
    ).get(prepared.deliveryId)).toEqual({ status: "accepted", variables_ciphertext: null });
  });

  it("does not expire a send while another worker still holds a valid lock", async () => {
    const prepared = await prepareBusinessDelivery("2026-09-20T10:01:00.000Z");
    testEnv.sqliteDb.prepare(
      `UPDATE email_deliveries
       SET status = 'processing', locked_by = 'worker_active',
           locked_until = '2026-09-20T10:02:00.000Z'
       WHERE id = ?`,
    ).run(prepared.deliveryId);

    await expect(dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
      deliveryId: prepared.deliveryId,
      now: new Date("2026-09-20T10:01:30.000Z"),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })).resolves.toEqual({ claimed: false });
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, locked_by, variables_ciphertext FROM email_deliveries WHERE id = ?",
    ).get(prepared.deliveryId)).toMatchObject({
      status: "processing",
      locked_by: "worker_active",
      variables_ciphertext: expect.any(String),
    });

    await expect(dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
      deliveryId: prepared.deliveryId,
      now: new Date("2026-09-20T10:02:00.000Z"),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })).resolves.toMatchObject({ status: "expired" });
  });

  it("stops automatic retries at the configured attempt limit", async () => {
    testEnv.sqliteDb.prepare(
      "UPDATE email_integrations SET max_automatic_attempts = 2 WHERE id = ?",
    ).run(INTEGRATION_ID);
    const prepared = await prepareBusinessDelivery();
    const fetchImpl = vi.fn(async () => jsonResponse(
      { name: "rate_limit_exceeded", code: "provider_throttle", message: "Too many requests." },
      { status: 429 },
    )) as unknown as typeof fetch;

    await expect(dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
      deliveryId: prepared.deliveryId,
      fetchImpl,
      now: NOW,
    })).resolves.toMatchObject({ status: "retry_scheduled", attemptNumber: 1 });
    await expect(dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId: INSTANCE_ID,
      deliveryId: prepared.deliveryId,
      fetchImpl,
      now: new Date("2026-09-20T11:00:00.000Z"),
    })).resolves.toMatchObject({ status: "failed", attemptNumber: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await runDeliveryScheduler(
      { ...testEnv.env, DB: testEnv.d1 },
      { now: new Date("2026-09-20T12:00:00.000Z") },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, attempt_count, next_attempt_at FROM email_deliveries WHERE id = ?",
    ).get(prepared.deliveryId)).toEqual({
      status: "failed",
      attempt_count: 2,
      next_attempt_at: null,
    });
  });

  it("validates sensitive retention configuration before contacting Provider", async () => {
    const prepared = await prepareBusinessDelivery();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(dispatchDelivery({
      db: testEnv.d1,
      env: { ...testEnv.env, SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS: "invalid" },
      instanceId: INSTANCE_ID,
      deliveryId: prepared.deliveryId,
      fetchImpl,
      now: NOW,
    })).resolves.toMatchObject({ status: "waiting_configuration" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
