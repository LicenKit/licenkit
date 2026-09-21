import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/types";
import { errorHandler } from "../src/middleware/error";
import { customerAuthRouter } from "../src/routes/customer-auth.routes";
import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../src/infra/delivery/crypto";
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
    executionContext?: ExecutionContext,
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
      executionContext,
    );
  }

  async function configureReadyEmail(): Promise<{
    integrationId: string;
    bindingId: string;
  }> {
    const integrationId = "emi_magic";
    const bindingId = "etb_magic";
    const now = new Date().toISOString();
    const credentialCiphertext = await encryptEnvelopeV1(
      JSON.stringify({ version: 1, apiKey: "re_magic_secret" }),
      testEnv.env,
      {
        accountId,
        table: "email_integrations",
        rowId: integrationId,
        field: "credential_ciphertext",
      },
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO email_integrations (
         id, account_id, provider, name, credential_ciphertext,
         default_from_email, default_from_name, max_automatic_attempts,
         status, created_at, updated_at
       ) VALUES (?, ?, 'resend', 'Primary', ?, 'licenses@example.test',
         'Magic Link', 4, 'active', ?, ?)`,
    ).run(integrationId, accountId, credentialCiphertext, now, now);
    testEnv.sqliteDb.prepare(
      `INSERT INTO email_template_bindings (
         id, account_id, email_integration_id, notification_type,
         contract_version, provider_template_ref,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, 'customer.portal_access_requested', 1,
         'portal-access-v1', 'active', ?, ?)`,
    ).run(bindingId, accountId, integrationId, now, now);
    return { integrationId, bindingId };
  }

  function challengeRows(): any[] {
    return testEnv.sqliteDb.prepare(
      `SELECT id, token_hash, delivery_id, consumed_at, revoked_at, created_at
       FROM customer_login_challenges ORDER BY created_at, id`
    ).all() as any[];
  }

  function deliveryRows(): any[] {
    return testEnv.sqliteDb.prepare(
      `SELECT id, status, variables_ciphertext, created_at
       FROM email_deliveries
       WHERE notification_type = 'customer.portal_access_requested'
       ORDER BY created_at, id`
    ).all() as any[];
  }

  async function magicToken(deliveryId: string): Promise<string> {
    const row = testEnv.sqliteDb.prepare(
      "SELECT variables_ciphertext FROM email_deliveries WHERE account_id = ? AND id = ?"
    ).get(accountId, deliveryId) as any;
    const variables = JSON.parse(await decryptEnvelopeV1(row.variables_ciphertext, testEnv.env, {
      accountId,
      table: "email_deliveries",
      rowId: deliveryId,
      field: "variables_ciphertext",
    }));
    return decodeURIComponent(new URL(variables.access_url).hash.slice("#token=".length));
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

  it("keeps production responses uniform and leaves the Outbox pending without an ExecutionContext", async () => {
    await configureReadyEmail();
    (testEnv.env as any).ENVIRONMENT = "production";

    const unknown = await requestMagicLink(
      "unknown@example.test",
      "turnstile-production-unknown",
    );
    const known = await requestMagicLink(
      "buyer@example.test",
      "turnstile-production-known",
    );

    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(known.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.json()).toEqual({ success: true, data: { accepted: true } });
    expect(await known.json()).toEqual({ success: true, data: { accepted: true } });
    expect(challengeRows()).toHaveLength(1);
    expect(deliveryRows()).toHaveLength(1);
    expect(deliveryRows()[0]).toMatchObject({
      status: "pending",
      variables_ciphertext: expect.any(String),
    });
    expect(siteverify).toHaveBeenCalledTimes(2);
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

  it("validates the shared email credential before the private email lookup", async () => {
    const { integrationId } = await configureReadyEmail();
    testEnv.sqliteDb.prepare(
      "UPDATE email_integrations SET credential_ciphertext = 'not-an-envelope' WHERE id = ?",
    ).run(integrationId);
    const originalPrepare = testEnv.d1.prepare.bind(testEnv.d1);
    let preflightQuerySeen = false;
    testEnv.d1.prepare = (query: string) => {
      if (query.includes("FROM email_integrations AS integration")) {
        preflightQuerySeen = true;
      }
      if (query.includes("FROM customers")) {
        expect(preflightQuerySeen).toBe(true);
      }
      return originalPrepare(query);
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const known = await requestMagicLink("buyer@example.test", "turnstile-broken-email-known");
    const unknown = await requestMagicLink("unknown@example.test", "turnstile-broken-email-unknown");
    expect(known.status).toBe(500);
    expect(unknown.status).toBe(500);
    expect((await known.json() as any).error.code).toBe((await unknown.json() as any).error.code);
    expect(challengeRows()).toEqual([]);
    expect(deliveryRows()).toEqual([]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("buyer@example.test");
  });

  it("persists Challenge and Delivery before waitUntil dispatches the Provider request", async () => {
    await configureReadyEmail();
    const originalBatch = testEnv.d1.batch.bind(testEnv.d1);
    let committed = false;
    testEnv.d1.batch = async (statements: any[]) => {
      const result = await originalBatch(statements);
      committed = true;
      return result;
    };
    const providerCalls: Array<{ body: any; committed: boolean }> = [];
    const requestFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("challenges.cloudflare.com")) {
        return new Response(JSON.stringify({
          success: true,
          action: "customer_magic_link",
          hostname: "license.example.test",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      providerCalls.push({
        body: JSON.parse(String(init?.body)),
        committed,
      });
      return new Response(JSON.stringify({ id: "email_magic_business" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", requestFetch);
    const pending: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const response = await requestMagicLink(
      "buyer@example.test",
      "turnstile-background-dispatch",
      executionContext,
    );
    expect(response.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);

    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].committed).toBe(true);
    expect(providerCalls[0].body.template).toMatchObject({
      id: "portal-access-v1",
      variables: {
        account_name: "Magic Link",
        expires_at: expect.stringMatching(/Z$/),
        access_url: expect.stringMatching(
          /^https:\/\/license\.example\.test\/customer\/magic\/auth#token=mlk_[0-9a-f]{64}$/,
        ),
      },
    });
    expect(Object.keys(providerCalls[0].body.template.variables).sort()).toEqual([
      "access_url",
      "account_name",
      "expires_at",
    ]);
    expect(JSON.stringify(providerCalls[0].body)).not.toContain(":null");
    const acceptedDelivery = testEnv.sqliteDb.prepare(
      `SELECT status, variables_ciphertext, variables_expires_at FROM email_deliveries
       WHERE notification_type = 'customer.portal_access_requested'`,
    ).get() as any;
    expect(acceptedDelivery.status).toBe("accepted");
    expect(acceptedDelivery.variables_ciphertext).toBeTruthy();
    expect(acceptedDelivery.variables_expires_at).toBeTruthy();
  });

  it("keeps the current link and Delivery unchanged during the D1 cooldown", async () => {
    expect((await requestMagicLink()).status).toBe(200);
    const originalChallenge = challengeRows()[0];
    const originalDelivery = deliveryRows()[0];

    expect((await requestMagicLink()).status).toBe(200);
    expect(challengeRows()).toEqual([originalChallenge]);
    expect(deliveryRows()).toEqual([originalDelivery]);
    expect(challengeRows()[0].revoked_at).toBeNull();
    expect(deliveryRows()[0].status).toBe("waiting_configuration");
    expect(deliveryRows()[0].variables_ciphertext).toBeTruthy();
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
      status: "expired",
      variables_ciphertext: null,
    });
    expect(challenges.filter((row) => row.revoked_at === null)).toHaveLength(1);
    expect(deliveries.filter((row) => row.status === "waiting_configuration")).toHaveLength(1);

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
      status: "waiting_configuration",
    });
    expect(deliveryRows()[0].variables_ciphertext).toBeTruthy();
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
