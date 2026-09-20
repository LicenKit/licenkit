import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/types";
import { errorHandler } from "../src/middleware/error";
import { customerAuthRouter } from "../src/routes/customer-auth.routes";
import { decryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

function customerAuthApp() {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.route("/api/v1/customer/auth", customerAuthRouter);
  return app;
}

describe("V1 Customer Magic Link request contract", () => {
  let testEnv: TestEnvContext;
  let siteverify: ReturnType<typeof vi.fn>;
  const accountId = "acc_magic";
  const customerId = "cus_magic";

  beforeEach(() => {
    testEnv = createTestEnv({
      STORAGE_ENCRYPTION_KEY_ID: "test-primary",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: "turnstile-site-key",
    } as any);
    const now = new Date().toISOString();
    testEnv.sqliteDb.prepare(
      `INSERT INTO system_settings (id, instance_name, app_url, site_url, api_base_url, initialized_at, updated_at)
       VALUES ('current', 'Magic Link', 'https://license.example.test', 'https://license.example.test',
               'https://license.example.test/api/v1', ?, ?)`
    ).run(now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO accounts (id, name, slug, status, created_at, updated_at)
       VALUES (?, 'Magic Link', 'magic', 'active', ?, ?)`
    ).run(accountId, now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO customers (id, account_id, email, name, status, created_at, updated_at)
       VALUES (?, ?, 'buyer@example.test', 'Buyer', 'active', ?, ?)`
    ).run(customerId, accountId, now, now);
    siteverify = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      action: "customer_magic_link",
      hostname: "license.example.test",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", siteverify);
  });

  afterEach(() => vi.unstubAllGlobals());

  async function requestMagicLink(
    email = "buyer@example.test",
    turnstileToken = `turnstile-${crypto.randomUUID()}`,
  ): Promise<Response> {
    return customerAuthApp().request(
      "https://license.example.test/api/v1/customer/auth/magic-link",
      {
        method: "POST",
        headers: {
          Origin: "https://license.example.test",
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10",
        },
        body: JSON.stringify({ accountSlug: "magic", email, turnstileToken }),
      },
      testEnv.env,
    );
  }

  function challengeRows(): any[] {
    return testEnv.sqliteDb.prepare(
      `SELECT id, token_hash, delivery_id, consumed_at, revoked_at, created_at
       FROM customer_login_challenges ORDER BY created_at, id`
    ).all() as any[];
  }

  function deliveryRows(): any[] {
    return testEnv.sqliteDb.prepare(
      `SELECT id, status, payload_ciphertext, payload_cleared_at, created_at
       FROM outbound_deliveries
       WHERE event_type = 'customer.portal_access_requested'
       ORDER BY created_at, id`
    ).all() as any[];
  }

  async function magicToken(deliveryId: string): Promise<string> {
    const row = testEnv.sqliteDb.prepare(
      "SELECT payload_ciphertext FROM outbound_deliveries WHERE account_id = ? AND id = ?"
    ).get(accountId, deliveryId) as any;
    const payload = JSON.parse(await decryptEnvelopeV1(row.payload_ciphertext, testEnv.env, {
      accountId,
      table: "outbound_deliveries",
      rowId: deliveryId,
      field: "payload_ciphertext",
    }));
    return decodeURIComponent(new URL(payload.data.access_url).hash.slice("#token=".length));
  }

  it("returns the runtime Turnstile Sitekey without caching it", async () => {
    const app = customerAuthApp();
    const response = await app.request(
      "https://license.example.test/api/v1/customer/auth/config",
      {},
      testEnv.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: true,
      data: { turnstileSiteKey: "turnstile-site-key" },
    });

    delete (testEnv.env as any).TURNSTILE_SITE_KEY;
    const missing = await app.request(
      "https://license.example.test/api/v1/customer/auth/config",
      {},
      testEnv.env,
    );
    expect(missing.status).toBe(503);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect((await missing.json() as any).error.code).toBe("TURNSTILE_CONFIGURATION_ERROR");
  });

  it("verifies Turnstile before creating one Challenge and Delivery", async () => {
    const token = "turnstile-success-token";
    siteverify
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        action: "customer_magic_link",
        hostname: "license.example.test",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await requestMagicLink("buyer@example.test", token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: { accepted: true } });
    expect(challengeRows()).toHaveLength(1);
    expect(deliveryRows()).toHaveLength(1);
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.magic_link.requested'"
    ).get()).toEqual({ count: 1 });

    const submitted = siteverify.mock.calls.map((call) => new URLSearchParams(String(call[1]?.body)));
    expect(submitted).toHaveLength(2);
    expect(submitted[0].get("response")).toBe(token);
    expect(submitted[0].get("secret")).toBe("turnstile-secret");
    expect(submitted[0].get("idempotency_key")).toBe(submitted[1].get("idempotency_key"));
    const storedRows = {
      challenges: challengeRows(),
      deliveries: deliveryRows(),
      audits: testEnv.sqliteDb.prepare("SELECT * FROM audit_logs").all(),
    };
    expect(JSON.stringify(storedRows)).not.toContain(token);
  });

  it.each([
    ["unsuccessful", { success: false, action: "customer_magic_link", hostname: "license.example.test" }],
    ["wrong action", { success: true, action: "other_action", hostname: "license.example.test" }],
    ["wrong hostname", { success: true, action: "customer_magic_link", hostname: "attacker.example.test" }],
  ])("fails closed for a %s Siteverify result", async (_case, result) => {
    siteverify.mockResolvedValueOnce(new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const response = await requestMagicLink();
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe("TURNSTILE_VERIFICATION_FAILED");
    expect(challengeRows()).toEqual([]);
    expect(deliveryRows()).toEqual([]);
  });

  it("keeps unknown-email responses uniform without persisting an identity cooldown record", async () => {
    const response = await requestMagicLink("unknown@example.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: { accepted: true } });
    expect(challengeRows()).toEqual([]);
    expect(deliveryRows()).toEqual([]);
  });

  it("fails before email lookup when shared Magic Link timing configuration is invalid", async () => {
    (testEnv.env as any).CUSTOMER_MAGIC_LINK_COOLDOWN_SECONDS = "invalid";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const known = await requestMagicLink("buyer@example.test", "turnstile-invalid-config-known");
    const unknown = await requestMagicLink("unknown@example.test", "turnstile-invalid-config-unknown");
    expect(known.status).toBe(500);
    expect(unknown.status).toBe(500);
    expect((await known.json() as any).error.code).toBe((await unknown.json() as any).error.code);
    expect(challengeRows()).toEqual([]);
    expect(deliveryRows()).toEqual([]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("buyer@example.test");
  });

  it("validates a configured Notification Gateway before email lookup", async () => {
    const now = new Date().toISOString();
    testEnv.sqliteDb.prepare(
      `INSERT INTO outbound_endpoints (
         id, account_id, endpoint_type, name, url, signing_secret_ciphertext,
         subscribed_events_json, timeout_ms, max_automatic_attempts, status, created_at, updated_at
       ) VALUES (
         'oep_magic_broken', ?, 'notification_gateway', 'Broken Gateway',
         'https://notify.example.test/hooks', 'not-an-envelope',
         '["customer.portal_access_requested"]', 10000, 4, 'active', ?, ?
       )`,
    ).run(accountId, now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO outbound_deliveries (
         id, account_id, endpoint_id, event_type, idempotency_key, target_url,
         signing_secret_ciphertext, status, attempt_count, automatic_attempt_count,
         max_automatic_attempts, accepted_at, created_at, updated_at
       ) VALUES (
         'dly_magic_endpoint_test', ?, 'oep_magic_broken', 'endpoint.test',
         'endpoint.test:magic-broken', 'https://notify.example.test/hooks',
         'snapshot', 'accepted', 1, 1, 4, ?, ?, ?
       )`,
    ).run(accountId, now, now, now);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const known = await requestMagicLink("buyer@example.test", "turnstile-broken-gateway-known");
    const unknown = await requestMagicLink("unknown@example.test", "turnstile-broken-gateway-unknown");
    expect(known.status).toBe(500);
    expect(unknown.status).toBe(500);
    expect((await known.json() as any).error.code).toBe((await unknown.json() as any).error.code);
    expect(challengeRows()).toEqual([]);
    expect(deliveryRows()).toEqual([]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("buyer@example.test");
  });

  it("keeps the current link and Delivery unchanged during the D1 cooldown", async () => {
    expect((await requestMagicLink()).status).toBe(200);
    const originalChallenge = challengeRows()[0];
    const originalDelivery = deliveryRows()[0];

    expect((await requestMagicLink()).status).toBe(200);
    expect(challengeRows()).toEqual([originalChallenge]);
    expect(deliveryRows()).toEqual([originalDelivery]);
    expect(challengeRows()[0].revoked_at).toBeNull();
    expect(deliveryRows()[0].status).toBe("blocked_configuration");
    expect(deliveryRows()[0].payload_ciphertext).toBeTruthy();
  });

  it("allows only one concurrent replacement and revokes the old link after the winner exists", async () => {
    expect((await requestMagicLink()).status).toBe(200);
    const original = challengeRows()[0];
    const originalToken = await magicToken(original.delivery_id);
    testEnv.sqliteDb.prepare(
      "UPDATE customer_login_challenges SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(original.id);

    const responses = await Promise.all([
      requestMagicLink("buyer@example.test", "turnstile-concurrent-one"),
      requestMagicLink("buyer@example.test", "turnstile-concurrent-two"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const challenges = challengeRows();
    const deliveries = deliveryRows();
    expect(challenges).toHaveLength(2);
    expect(deliveries).toHaveLength(2);
    expect(challenges.find((row) => row.id === original.id)?.revoked_at).toBeTruthy();
    expect(deliveries.find((row) => row.id === original.delivery_id)).toMatchObject({
      status: "payload_expired",
      payload_ciphertext: null,
    });
    expect(challenges.filter((row) => row.revoked_at === null)).toHaveLength(1);
    expect(deliveries.filter((row) => row.status === "blocked_configuration")).toHaveLength(1);

    const consumeOld = await customerAuthApp().request(
      "https://license.example.test/api/v1/customer/auth/magic-link/consume",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({ accountSlug: "magic", token: originalToken }),
      },
      testEnv.env,
    );
    expect(consumeOld.status).toBe(400);
    expect((await consumeOld.json() as any).error.code).toBe("CUSTOMER_MAGIC_LINK_INVALID");
  });

  it("rolls back a failed replacement without revoking the old link", async () => {
    expect((await requestMagicLink()).status).toBe(200);
    const original = challengeRows()[0];
    const originalToken = await magicToken(original.delivery_id);
    testEnv.sqliteDb.prepare(
      "UPDATE customer_login_challenges SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(original.id);

    const originalBatch = testEnv.d1.batch.bind(testEnv.d1);
    testEnv.d1.batch = (statements: any[]) => originalBatch([
      ...statements,
      testEnv.d1.prepare("INSERT INTO table_that_does_not_exist (id) VALUES ('fail')"),
    ]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await requestMagicLink("buyer@example.test", "turnstile-failed-replacement");
    expect(failed.status).toBe(500);
    testEnv.d1.batch = originalBatch;

    expect(challengeRows()).toHaveLength(1);
    expect(challengeRows()[0].revoked_at).toBeNull();
    expect(deliveryRows()).toHaveLength(1);
    expect(deliveryRows()[0]).toMatchObject({
      id: original.delivery_id,
      status: "blocked_configuration",
    });
    expect(deliveryRows()[0].payload_ciphertext).toBeTruthy();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("turnstile-failed-replacement");

    const consumeOld = await customerAuthApp().request(
      "https://license.example.test/api/v1/customer/auth/magic-link/consume",
      {
        method: "POST",
        headers: { Origin: "https://license.example.test", "Content-Type": "application/json" },
        body: JSON.stringify({ accountSlug: "magic", token: originalToken }),
      },
      testEnv.env,
    );
    expect(consumeOld.status).toBe(200);
  });
});
