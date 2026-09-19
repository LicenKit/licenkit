import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { requirePublicHttpsUrl } from "../src/infra/delivery/url-policy";
import { prepareNotificationDelivery } from "../src/services/delivery/outbox";
import { dispatchDelivery } from "../src/infra/delivery/dispatcher";
import { computeHmacSha256 } from "../src/infra/crypto";
import { runDeliveryScheduler } from "../src/services/delivery/scheduler";

describe("V1 outbound Delivery", () => {
  let testEnv: TestEnvContext;
  const accountId = "acc_delivery";
  const endpointId = "oep_delivery";
  const secret = "notification-signing-secret";

  beforeEach(async () => {
    testEnv = createTestEnv({ STORAGE_ENCRYPTION_KEY_ID: "test-primary", ENVIRONMENT: "test" });
    const now = new Date().toISOString();
    const encryptedSecret = await encryptEnvelopeV1(secret, testEnv.env, {
      accountId,
      table: "outbound_endpoints",
      rowId: endpointId,
      field: "signing_secret_ciphertext",
    });
    testEnv.sqliteDb.prepare(
      `INSERT INTO accounts (id, name, slug, status, created_at, updated_at)
       VALUES (?, 'Delivery', 'delivery', 'active', ?, ?)`
    ).run(accountId, now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO outbound_endpoints (
         id, account_id, endpoint_type, name, url, signing_secret_ciphertext,
         subscribed_events_json, timeout_ms, max_automatic_attempts, status, created_at, updated_at
       ) VALUES (?, ?, 'notification_gateway', 'Gateway', 'https://notify.example.test/hooks', ?, ?, 10000, 4, 'active', ?, ?)`
    ).run(endpointId, accountId, encryptedSecret, JSON.stringify(["customer.license_issued"]), now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO outbound_deliveries (
         id, account_id, endpoint_id, event_type, idempotency_key, target_url,
         signing_secret_ciphertext, status, attempt_count, automatic_attempt_count,
         max_automatic_attempts, accepted_at, created_at, updated_at
       ) VALUES ('dly_delivery_endpoint_test', ?, ?, 'endpoint.test', 'endpoint.test:delivery',
         'https://notify.example.test/hooks', 'snapshot', 'accepted', 1, 1, 4, ?, ?, ?)`
    ).run(accountId, endpointId, now, now, now);
  });

  it("signs, retries the same snapshot, records Attempts, and clears accepted payload", async () => {
    const prepared = await prepareNotificationDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      eventType: "customer.license_issued",
      recipientEmail: "buyer@example.test",
      payload: { license_id: "lic_delivery", license_key: "LK-SECRET-KEY" },
    });
    expect(prepared.status).toBe("pending");
    await testEnv.d1.batch(prepared.statements);

    const calls: Array<{ body: string; timestamp: string; signature: string }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        body: String(init?.body),
        timestamp: headers.get("X-LicenKit-Timestamp")!,
        signature: headers.get("X-LicenKit-Signature")!,
      });
      return calls.length === 1
        ? new Response(JSON.stringify({ error: "temporary", token: "must-not-be-stored" }), { status: 500 })
        : new Response("accepted", { status: 202 });
    });

    const first = await dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      deliveryId: prepared.deliveryId,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(first.status).toBe("retry_scheduled");
    testEnv.sqliteDb.prepare(
      "UPDATE outbound_deliveries SET next_attempt_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", prepared.deliveryId);

    const second = await dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      deliveryId: prepared.deliveryId,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(second.status).toBe("accepted");
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toBe(calls[0].body);
    for (const call of calls) {
      expect(call.signature).toBe(`v1=${await computeHmacSha256(`${call.timestamp}.${call.body}`, secret)}`);
    }

    const row = testEnv.sqliteDb.prepare(
      `SELECT status, attempt_count, automatic_attempt_count, payload_ciphertext, payload_cleared_at
       FROM outbound_deliveries WHERE id = ?`
    ).get(prepared.deliveryId) as any;
    expect(row.status).toBe("accepted");
    expect(row.attempt_count).toBe(2);
    expect(row.automatic_attempt_count).toBe(2);
    expect(row.payload_ciphertext).toBeNull();
    expect(row.payload_cleared_at).toBeTruthy();
    const attempts = testEnv.sqliteDb.prepare(
      `SELECT attempt_number, attempt_source, outcome, response_body_redacted
       FROM outbound_attempts WHERE delivery_id = ? ORDER BY attempt_number`
    ).all(prepared.deliveryId) as any[];
    expect(attempts.map((item) => item.attempt_source)).toEqual(["initial", "automatic_retry"]);
    expect(attempts[0].response_body_redacted).toContain('"token":"[REDACTED]"');
    expect(attempts[0].response_body_redacted).not.toContain("must-not-be-stored");
  });

  it("rejects non-public targets before dispatch", () => {
    expect(() => requirePublicHttpsUrl("http://example.com/hook")).toThrow(/HTTPS/);
    expect(() => requirePublicHttpsUrl("https://127.0.0.1/hook")).toThrow(/IP literal/);
    expect(() => requirePublicHttpsUrl("https://localhost/hook")).toThrow(/Localhost/);
    expect(() => requirePublicHttpsUrl("https://user:pass@example.com/hook")).toThrow(/credentials/);
    expect(() => requirePublicHttpsUrl("https://example.com:8443/hook")).toThrow(/ports/);
    expect(requirePublicHttpsUrl("https://notify.example.test/hook").hostname).toBe("notify.example.test");
  });

  it("binds ciphertext to its account, table, row, and field", async () => {
    const ciphertext = await encryptEnvelopeV1("sensitive", testEnv.env, {
      accountId,
      table: "outbound_deliveries",
      rowId: "dly_one",
      field: "payload_ciphertext",
    });
    await expect(decryptEnvelopeV1(ciphertext, testEnv.env, {
      accountId,
      table: "outbound_deliveries",
      rowId: "dly_two",
      field: "payload_ciphertext",
    })).rejects.toThrow("DELIVERY_ENVELOPE_AUTHENTICATION_FAILED");
  });

  it("reclaims an expired processing lease", async () => {
    const prepared = await prepareNotificationDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      eventType: "customer.license_issued",
      recipientEmail: "buyer@example.test",
      payload: { license_id: "lic_lease", license_key: "LK-LEASE-SECRET" },
    });
    await testEnv.d1.batch(prepared.statements);
    testEnv.sqliteDb.prepare(
      `UPDATE outbound_deliveries
       SET status = 'processing', locked_by = 'dead-worker', locked_until = '2000-01-01T00:00:00.000Z'
       WHERE id = ?`
    ).run(prepared.deliveryId);
    const result = await dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      deliveryId: prepared.deliveryId,
      fetchImpl: vi.fn(async () => new Response("accepted", { status: 202 })) as typeof fetch,
    });
    expect(result.status).toBe("accepted");
    expect((testEnv.sqliteDb.prepare("SELECT status FROM outbound_deliveries WHERE id = ?").get(prepared.deliveryId) as any).status)
      .toBe("accepted");
  });

  it("uses the four-request automatic budget and will not make a fifth request", async () => {
    const prepared = await prepareNotificationDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      eventType: "customer.license_issued",
      recipientEmail: "buyer@example.test",
      payload: { license_id: "lic_budget", license_key: "LK-BUDGET-SECRET" },
    });
    await testEnv.d1.batch(prepared.statements);
    const fetchImpl = vi.fn(async () => new Response("temporary failure", { status: 503 })) as typeof fetch;

    const statuses: Array<string | undefined> = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await dispatchDelivery({
        db: testEnv.d1,
        env: testEnv.env,
        accountId,
        deliveryId: prepared.deliveryId,
        fetchImpl,
      });
      statuses.push(result.status);
      testEnv.sqliteDb.prepare(
        "UPDATE outbound_deliveries SET next_attempt_at = ? WHERE id = ?"
      ).run("2000-01-01T00:00:00.000Z", prepared.deliveryId);
    }

    expect(statuses).toEqual(["retry_scheduled", "retry_scheduled", "retry_scheduled", "failed"]);
    const exhausted = await dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      deliveryId: prepared.deliveryId,
      fetchImpl,
    });
    expect(exhausted.claimed).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(testEnv.sqliteDb.prepare(
      "SELECT attempt_count, automatic_attempt_count, status FROM outbound_deliveries WHERE id = ?"
    ).get(prepared.deliveryId)).toEqual({ attempt_count: 4, automatic_attempt_count: 4, status: "failed" });
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM outbound_attempts WHERE delivery_id = ?"
    ).get(prepared.deliveryId)).toEqual({ count: 4 });
  });

  it("expires sensitive payloads without making an HTTP attempt", async () => {
    const prepared = await prepareNotificationDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      eventType: "customer.license_issued",
      recipientEmail: "buyer@example.test",
      payload: { license_id: "lic_expired", license_key: "LK-EXPIRED-SECRET" },
    });
    await testEnv.d1.batch(prepared.statements);
    testEnv.sqliteDb.prepare(
      "UPDATE outbound_deliveries SET payload_expires_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", prepared.deliveryId);
    const fetchImpl = vi.fn(async () => new Response("must not be called", { status: 202 })) as typeof fetch;

    const result = await dispatchDelivery({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      deliveryId: prepared.deliveryId,
      fetchImpl,
    });
    expect(result.status).toBe("payload_expired");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, attempt_count, payload_ciphertext, payload_cleared_at
       FROM outbound_deliveries WHERE id = ?`
    ).get(prepared.deliveryId)).toMatchObject({
      status: "payload_expired",
      attempt_count: 0,
      payload_ciphertext: null,
    });
    expect((testEnv.sqliteDb.prepare(
      "SELECT payload_cleared_at FROM outbound_deliveries WHERE id = ?"
    ).get(prepared.deliveryId) as any).payload_cleared_at).toBeTruthy();
  });

  it("paginates active accounts so accounts after the first 100 are not starved", async () => {
    const now = new Date("2026-09-19T08:00:00.000Z");
    const createdAt = "2026-09-19T07:00:00.000Z";
    const expiredAt = "2026-09-19T07:30:00.000Z";

    for (let index = 0; index < 101; index++) {
      const suffix = String(index).padStart(3, "0");
      const pagedAccountId = `acc_paged_${suffix}`;
      testEnv.sqliteDb.prepare(
        `INSERT INTO accounts (id, name, slug, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`
      ).run(pagedAccountId, `Paged ${suffix}`, `paged-${suffix}`, createdAt, createdAt);
      testEnv.sqliteDb.prepare(
        `INSERT INTO outbound_endpoints (
           id, account_id, endpoint_type, name, url, signing_secret_ciphertext,
           subscribed_events_json, timeout_ms, max_automatic_attempts, status,
           created_at, updated_at
         ) VALUES (?, ?, 'notification_gateway', 'Paged Gateway',
           'https://notify.example.test/hooks', 'encrypted-placeholder', '["*"]',
           10000, 4, 'active', ?, ?)`
      ).run(`oep_paged_${suffix}`, pagedAccountId, createdAt, createdAt);
      testEnv.sqliteDb.prepare(
        `INSERT INTO outbound_deliveries (
           id, account_id, endpoint_id, event_type, idempotency_key, target_url,
           signing_secret_ciphertext, payload_ciphertext, payload_expires_at,
           status, max_automatic_attempts, created_at, updated_at
         ) VALUES (?, ?, ?, 'customer.license_issued', ?,
           'https://notify.example.test/hooks', 'encrypted-placeholder',
           'encrypted-placeholder', ?, 'pending', 4, ?, ?)`
      ).run(
        `dly_paged_${suffix}`,
        pagedAccountId,
        `oep_paged_${suffix}`,
        `customer.license_issued:paged-${suffix}`,
        expiredAt,
        createdAt,
        createdAt
      );
    }

    const result = await runDeliveryScheduler(testEnv.env, { accountLimit: 100, now });

    expect(result).toEqual({ accounts: 101, claimed: 101, accepted: 0, failed: 0 });
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM outbound_deliveries WHERE status = 'payload_expired'"
    ).get()).toEqual({ count: 101 });
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, payload_ciphertext FROM outbound_deliveries WHERE id = 'dly_paged_100'"
    ).get()).toEqual({ status: "payload_expired", payload_ciphertext: null });
  });
});
