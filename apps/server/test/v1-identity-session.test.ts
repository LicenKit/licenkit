import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/types";
import { errorHandler } from "../src/middleware/error";
import { setupRouter } from "../src/routes/setup.routes";
import { authRouter } from "../src/routes/auth.routes";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
} from "../src/services/identity/session";

const ORIGIN = "https://license.example.test";
const CUSTOMER_SITE_ORIGIN = "https://site.example.test";
const SETUP_TOKEN = "initial-setup-token-with-enough-entropy";

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${name}=([^;,]+)`));
  if (!match) throw new Error(`Cookie ${name} was not set: ${header}`);
  return match[1];
}

function expectOnlySnakeCaseJsonKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectOnlySnakeCaseJsonKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    expectOnlySnakeCaseJsonKeys(nested);
  }
}

function identityApp() {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.route("/api/v1/setup", setupRouter);
  app.route("/api/v1/admin/auth", authRouter);
  return app;
}

function setupBody(suffix = "primary") {
  return {
    setup_token: SETUP_TOKEN,
    user: {
      name: `Owner ${suffix}`,
      email: `owner-${suffix}@example.test`,
      password: `strong-password-${suffix}-123`,
    },
    instance: {
      name: `Example ${suffix}`,
      slug: `example-${suffix}`,
      site_url: `${CUSTOMER_SITE_ORIGIN}/site/`,
    },
  };
}

async function postJson(
  app: ReturnType<typeof identityApp>,
  path: string,
  body: unknown,
  env: TestEnvContext["env"],
  headers: Record<string, string> = {},
  requestOrigin = ORIGIN,
) {
  return app.request(
    `${requestOrigin}${path}`,
    {
      method: "POST",
      headers: { Origin: requestOrigin, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("V1 deployment setup and administrator identity", () => {
  let testEnv: TestEnvContext;

  beforeEach(() => {
    testEnv = createTestEnv({
      INITIAL_SETUP_TOKEN: SETUP_TOKEN,
      CUSTOMER_SITE_ORIGIN,
      ENVIRONMENT: "test",
    });
  });

  it("verifies the deployment token without persisting state", async () => {
    const app = identityApp();
    const initialStatus = await app.request(`${ORIGIN}/api/v1/setup/status`, {}, testEnv.env);
    expect(initialStatus.status).toBe(200);
    expect(initialStatus.headers.get("cache-control")).toBe("no-store");
    const initialStatusPayload = await initialStatus.json();
    expect(initialStatusPayload).toEqual({ success: true, data: { initialized: false } });
    expectOnlySnakeCaseJsonKeys(initialStatusPayload);

    const invalid = await postJson(
      app,
      "/api/v1/setup/verify-token",
      { setup_token: "wrong-token" },
      testEnv.env,
    );
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    const invalidPayload = await invalid.json() as any;
    expectOnlySnakeCaseJsonKeys(invalidPayload);
    expect(invalidPayload.error).toHaveProperty("request_id");
    expect(invalidPayload.error).not.toHaveProperty("requestId");

    const nonOriginHeader = await postJson(
      app,
      "/api/v1/setup/verify-token",
      { setup_token: SETUP_TOKEN },
      testEnv.env,
      { Origin: `${ORIGIN}/not-an-origin` },
    );
    expect(nonOriginHeader.status).toBe(403);

    const valid = await postJson(
      app,
      "/api/v1/setup/verify-token",
      { setup_token: SETUP_TOKEN },
      testEnv.env,
    );
    expect(valid.status).toBe(200);
    const validPayload = await valid.json();
    expect(validPayload).toEqual({ success: true, data: { valid: true } });
    expectOnlySnakeCaseJsonKeys(validPayload);

    for (const table of [
      "users",
      "instances",
      "instance_memberships",
      "admin_sessions",
      "audit_logs",
      "deployment_bootstrap",
    ]) {
      expect(testEnv.sqliteDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("atomically creates the User, Instance, Owner Membership and Session", async () => {
    const app = identityApp();
    const setup = await postJson(app, "/api/v1/setup", setupBody(), testEnv.env);
    expect(setup.status).toBe(201);
    expect(setup.headers.get("cache-control")).toBe("no-store");
    const cookieHeader = setup.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain(ADMIN_SESSION_COOKIE);
    expect(cookieHeader).toContain(ADMIN_CSRF_COOKIE);
    expect(cookieHeader).not.toContain("licenkit-admin-account");

    const payload = await setup.json() as any;
    expectOnlySnakeCaseJsonKeys(payload);
    expect(payload.data).toMatchObject({
      user: { name: "Owner primary", email: "owner-primary@example.test" },
      instance: {
        name: "Example primary",
        slug: "example-primary",
        site_url: `${CUSTOMER_SITE_ORIGIN}/site`,
        status: "active",
      },
      membership: { role: "owner", status: "active" },
    });
    expect(payload.data.instance.id).toMatch(/^ins_/);
    expect(payload.data.user.id).toMatch(/^usr_/);

    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM instances").get()).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare("SELECT role, status, joined_by_invitation_id FROM instance_memberships").get()).toEqual({
      role: "owner",
      status: "active",
      joined_by_invitation_id: null,
    });
    expect(testEnv.sqliteDb.prepare("SELECT singleton_key FROM deployment_bootstrap").get()).toEqual({
      singleton_key: "deployment",
    });
    expect(testEnv.sqliteDb.prepare("SELECT scope_type, instance_id, action FROM audit_logs").get()).toEqual({
      scope_type: "instance",
      instance_id: payload.data.instance.id,
      action: "instance.setup_completed",
    });
    expect(testEnv.sqliteDb.prepare("SELECT user_id FROM admin_sessions").get()).toEqual({
      user_id: payload.data.user.id,
    });

    const status = await app.request(`${ORIGIN}/api/v1/setup/status`, {}, testEnv.env);
    const statusPayload = await status.json();
    expect(statusPayload).toEqual({ success: true, data: { initialized: true } });
    expectOnlySnakeCaseJsonKeys(statusPayload);
  });

  it("accepts the configured cross-Origin Site URL and rejects every other Origin before writing", async () => {
    const app = identityApp();
    const invalidTokenBody = setupBody();
    invalidTokenBody.setup_token = "wrong-token";
    const invalidToken = await postJson(app, "/api/v1/setup", invalidTokenBody, testEnv.env);
    expect(invalidToken.status).toBe(401);

    const legacy = await postJson(app, "/api/v1/setup", {
      setupToken: SETUP_TOKEN,
      instanceName: "Legacy",
      accountSlug: "legacy",
      siteUrl: ORIGIN,
      owner: { name: "Owner", email: "owner@example.test", password: "strong-password-123" },
    }, testEnv.env);
    expect(legacy.status).toBe(400);
    expectOnlySnakeCaseJsonKeys(await legacy.json());

    const body = setupBody();
    body.instance.site_url = "https://other.example.test";
    const wrongOrigin = await postJson(app, "/api/v1/setup", body, testEnv.env);
    expect(wrongOrigin.status).toBe(400);
    const wrongOriginPayload = await wrongOrigin.json() as any;
    expect(wrongOriginPayload.error.code).toBe("SETUP_SITE_URL_ORIGIN_MISMATCH");
    expect(wrongOriginPayload.error.details).toEqual({
      app_origin: ORIGIN,
      customer_site_origin: CUSTOMER_SITE_ORIGIN,
      site_origin: "https://other.example.test",
    });
    expectOnlySnakeCaseJsonKeys(wrongOriginPayload);
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM deployment_bootstrap").get()).toEqual({ count: 0 });
  });

  it("rejects a cross-site Customer Origin before Setup writes any state", async () => {
    const crossSiteOrigin = "https://portal.other.test";
    testEnv.env.CUSTOMER_SITE_ORIGIN = crossSiteOrigin;
    const body = setupBody();
    body.instance.site_url = `${crossSiteOrigin}/customer`;

    const verify = await postJson(
      identityApp(),
      "/api/v1/setup/verify-token",
      { setup_token: SETUP_TOKEN },
      testEnv.env,
    );
    expect(verify.status).toBe(400);
    expect((await verify.json() as any).error).toMatchObject({
      code: "SETUP_CUSTOMER_SITE_CROSS_SITE_UNSUPPORTED",
      details: {
        app_origin: ORIGIN,
        customer_site_origin: crossSiteOrigin,
        app_site: "https://example.test",
        customer_site: "https://other.test",
      },
    });

    const response = await postJson(identityApp(), "/api/v1/setup", body, testEnv.env);
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe(
      "SETUP_CUSTOMER_SITE_CROSS_SITE_UNSUPPORTED",
    );
    for (const table of ["users", "instances", "deployment_bootstrap", "audit_logs"]) {
      expect(testEnv.sqliteDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it.each([
    ["missing", undefined, "test", "CUSTOMER_SITE_ORIGIN_MISSING"],
    ["path", "https://site.example.test/customer", "test", "CUSTOMER_SITE_ORIGIN_INVALID"],
    ["query", "https://site.example.test?source=test", "test", "CUSTOMER_SITE_ORIGIN_INVALID"],
    ["fragment", "https://site.example.test#customer", "test", "CUSTOMER_SITE_ORIGIN_INVALID"],
    ["credentials", "https://user:password@site.example.test", "test", "CUSTOMER_SITE_ORIGIN_INVALID"],
    ["non-canonical", "https://site.example.test/", "test", "CUSTOMER_SITE_ORIGIN_INVALID"],
    ["non-loopback development HTTP", "http://site.example.test", "development", "CUSTOMER_SITE_ORIGIN_INVALID"],
    ["IPv6 loopback development HTTP", "http://[::1]:4321", "development", "CUSTOMER_SITE_ORIGIN_INVALID"],
    ["production HTTP", "http://site.example.test", "production", "CUSTOMER_SITE_ORIGIN_INVALID"],
    ["production localhost HTTP", "http://localhost:4321", "production", "CUSTOMER_SITE_ORIGIN_INVALID"],
  ])("rejects an invalid %s Customer Site Origin configuration without writing", async (
    _case,
    configuredOrigin,
    environment,
    expectedCode,
  ) => {
    testEnv.env.CUSTOMER_SITE_ORIGIN = configuredOrigin;
    testEnv.env.ENVIRONMENT = environment;
    const response = await postJson(identityApp(), "/api/v1/setup", setupBody(), testEnv.env);
    expect(response.status).toBe(500);
    const payload = await response.json() as any;
    expect(payload.error.code).toBe(expectedCode);
    if (expectedCode === "CUSTOMER_SITE_ORIGIN_INVALID") {
      expect(payload.error.details.violation).toEqual(expect.any(String));
    }
    if (_case === "credentials") {
      expect(JSON.stringify(payload)).not.toContain("user:password");
    }
    for (const table of ["users", "instances", "deployment_bootstrap", "audit_logs"]) {
      expect(testEnv.sqliteDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it.each([
    "http://localhost:4321",
    "http://127.0.0.1:4321",
  ])("accepts the explicit non-production loopback Customer Site Origin %s", async (origin) => {
    testEnv.env.CUSTOMER_SITE_ORIGIN = origin;
    testEnv.env.ENVIRONMENT = "development";
    const body = setupBody();
    body.instance.site_url = `${origin}/site`;

    const apiOrigin = `${new URL(origin).protocol}//${new URL(origin).hostname}:8787`;
    const response = await postJson(
      identityApp(),
      "/api/v1/setup",
      body,
      testEnv.env,
      {},
      apiOrigin,
    );

    expect(response.status).toBe(201);
    expect(testEnv.sqliteDb.prepare("SELECT site_url FROM instances").get()).toEqual({
      site_url: `${origin}/site`,
    });
  });

  it("allows exactly one concurrent final Setup submission", async () => {
    const app = identityApp();
    const responses = await Promise.all([
      postJson(app, "/api/v1/setup", setupBody("one"), testEnv.env),
      postJson(app, "/api/v1/setup", setupBody("two"), testEnv.env),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    expect((await rejected.json() as any).error.code).toBe("SETUP_ALREADY_COMPLETED");
    for (const table of ["users", "instances", "instance_memberships", "admin_sessions", "audit_logs", "deployment_bootstrap"]) {
      expect(testEnv.sqliteDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
    }
  });

  it("preserves the original Setup batch failure when bootstrap did not complete", async () => {
    const app = identityApp();
    const originalBatch = testEnv.d1.batch;
    testEnv.d1.batch = async () => {
      throw new Error("ORIGINAL_SETUP_BATCH_FAILURE");
    };
    const failed = await postJson(app, "/api/v1/setup", setupBody(), testEnv.env);
    testEnv.d1.batch = originalBatch;

    expect(failed.status).toBe(500);
    const failedPayload = await failed.json() as any;
    expect(failedPayload.error.message).toBe("ORIGINAL_SETUP_BATCH_FAILURE");
    expectOnlySnakeCaseJsonKeys(failedPayload);
    expect(testEnv.sqliteDb.prepare("SELECT COUNT(*) AS count FROM deployment_bootstrap").get()).toEqual({ count: 0 });
  });

  it("treats partially initialized relationships as inconsistent", async () => {
    const now = new Date().toISOString();
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES ('usr_partial', 'partial@example.test', 'unused', 'Partial', ?, ?)`,
    ).run(now, now);
    const app = identityApp();
    const status = await app.request(`${ORIGIN}/api/v1/setup/status`, {}, testEnv.env);
    expect(status.status).toBe(500);
    expect((await status.json() as any).error.code).toBe("SETUP_STATE_INCONSISTENT");

    const verify = await postJson(
      app,
      "/api/v1/setup/verify-token",
      { setup_token: SETUP_TOKEN },
      testEnv.env,
    );
    expect(verify.status).toBe(500);
    expect((await verify.json() as any).error.code).toBe("SETUP_STATE_INCONSISTENT");
  });

  it("logs in with only email/password and resolves the current Membership on every request", async () => {
    const app = identityApp();
    const body = setupBody();
    expect((await postJson(app, "/api/v1/setup", body, testEnv.env)).status).toBe(201);

    const legacyLogin = await postJson(app, "/api/v1/admin/auth/login", {
      accountSlug: body.instance.slug,
      email: body.user.email,
      password: body.user.password,
    }, testEnv.env);
    expect(legacyLogin.status).toBe(400);

    const login = await postJson(app, "/api/v1/admin/auth/login", {
      email: body.user.email.toUpperCase(),
      password: body.user.password,
    }, testEnv.env);
    expect(login.status).toBe(200);
    const loginPayload = await login.json() as any;
    expectOnlySnakeCaseJsonKeys(loginPayload);
    expect(loginPayload.data).toMatchObject({
      user: { email: body.user.email },
      instance: { slug: body.instance.slug },
      membership: { role: "owner", status: "active" },
    });
    expect(login.headers.get("set-cookie")).not.toContain("licenkit-admin-account");

    const sessionToken = cookieValue(login, ADMIN_SESSION_COOKIE);
    const csrfToken = cookieValue(login, ADMIN_CSRF_COOKIE);
    const cookie = `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`;
    testEnv.sqliteDb.prepare("UPDATE instances SET status = 'suspended'").run();
    testEnv.sqliteDb.prepare("UPDATE instance_memberships SET role = 'viewer'").run();
    testEnv.sqliteDb.prepare("UPDATE instances SET status = 'active'").run();

    const session = await app.request(
      `${ORIGIN}/api/v1/admin/auth/session`,
      { headers: { Cookie: cookie } },
      testEnv.env,
    );
    expect(session.status).toBe(200);
    const sessionPayload = await session.json() as any;
    expect(sessionPayload.data.membership).toEqual({ role: "viewer", status: "active" });
    expectOnlySnakeCaseJsonKeys(sessionPayload);

    const missingCsrf = await app.request(
      `${ORIGIN}/api/v1/admin/auth/logout`,
      { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } },
      testEnv.env,
    );
    expect(missingCsrf.status).toBe(403);

    const logout = await app.request(
      `${ORIGIN}/api/v1/admin/auth/logout`,
      {
        method: "POST",
        headers: { Cookie: cookie, Origin: ORIGIN, "X-CSRF-Token": csrfToken },
      },
      testEnv.env,
    );
    expect(logout.status).toBe(200);
    const logoutPayload = await logout.json() as any;
    expect(logoutPayload.data).toEqual({ logged_out: true });
    expectOnlySnakeCaseJsonKeys(logoutPayload);
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE scope_type = 'identity' AND instance_id IS NULL",
    ).get()).toEqual({ count: 2 });

    const revoked = await app.request(
      `${ORIGIN}/api/v1/admin/auth/session`,
      { headers: { Cookie: cookie } },
      testEnv.env,
    );
    expect(revoked.status).toBe(401);
  });

  it("rejects a User immediately after the current Membership is disabled", async () => {
    const app = identityApp();
    const body = setupBody();
    expect((await postJson(app, "/api/v1/setup", body, testEnv.env)).status).toBe(201);
    const login = await postJson(app, "/api/v1/admin/auth/login", {
      email: body.user.email,
      password: body.user.password,
    }, testEnv.env);
    const cookie = `${ADMIN_SESSION_COOKIE}=${cookieValue(login, ADMIN_SESSION_COOKIE)}; ${ADMIN_CSRF_COOKIE}=${cookieValue(login, ADMIN_CSRF_COOKIE)}`;
    testEnv.sqliteDb.prepare("UPDATE instances SET status = 'suspended'").run();
    testEnv.sqliteDb.prepare("UPDATE instance_memberships SET status = 'disabled'").run();
    testEnv.sqliteDb.prepare("UPDATE instances SET status = 'active'").run();

    const session = await app.request(
      `${ORIGIN}/api/v1/admin/auth/session`,
      { headers: { Cookie: cookie } },
      testEnv.env,
    );
    expect(session.status).toBe(401);
  });
});
