import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../src/middleware/error";
import { systemRouter } from "../src/routes/system.routes";
import type { AppContext } from "../src/types";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

function expectOnlySnakeCaseJsonKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectOnlySnakeCaseJsonKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    expect(key).not.toMatch(/[A-Z]/);
    expectOnlySnakeCaseJsonKeys(nested);
  }
}

describe("V1 readiness without Scheduler persistence", () => {
  let testEnv: TestEnvContext;
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.route("/", systemRouter);

  beforeEach(() => {
    testEnv = createTestEnv({
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    });
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES ('usr_system_owner', 'owner@example.test', 'unused', 'Owner', ?, ?)`,
    ).run("2026-09-19T11:00:00.000Z", "2026-09-19T11:00:00.000Z");
    testEnv.sqliteDb.prepare(
      `INSERT INTO instances (id, name, slug, site_url, status, created_at, updated_at)
       VALUES ('ins_system', 'System', 'system', 'https://site.example.test', 'active', ?, ?)`,
    ).run("2026-09-19T11:00:00.000Z", "2026-09-19T11:00:00.000Z");
    testEnv.sqliteDb.prepare(
      `INSERT INTO instance_memberships (
         instance_id, user_id, role, status, joined_by_invitation_id, created_at, updated_at
       ) VALUES ('ins_system', 'usr_system_owner', 'owner', 'active', NULL, ?, ?)`,
    ).run("2026-09-19T11:00:00.000Z", "2026-09-19T11:00:00.000Z");
    testEnv.sqliteDb.prepare(
      `INSERT INTO deployment_bootstrap (singleton_key, completed_at)
       VALUES ('deployment', ?)`,
    ).run("2026-09-19T11:00:00.000Z");
  });

  it("serializes System status with only snake_case public JSON keys", async () => {
    const response = await app.request(
      "https://license.example.test/status",
      {},
      testEnv.env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data).toMatchObject({
      initialized: true,
      instance_name: "System",
      app_url: "https://license.example.test",
      site_url: "https://site.example.test",
      api_base_url: "https://license.example.test/api/v1",
      initialized_at: "2026-09-19T11:00:00.000Z",
    });
    expectOnlySnakeCaseJsonKeys(body);
  });

  it("does not require or expose a persisted Scheduler heartbeat", async () => {
    const response = await app.request(
      "https://license.example.test/readiness",
      {},
      testEnv.env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data.ready).toBe(true);
    expect(body.data.checks).not.toHaveProperty("schedulerLastSuccess");
    expect(body.data).not.toHaveProperty("scheduler");
    expectOnlySnakeCaseJsonKeys(body);
  });

  it("rejects an inconsistent deployment state with relationship diagnostics", async () => {
    testEnv.sqliteDb.prepare(
      "DELETE FROM deployment_bootstrap WHERE singleton_key = 'deployment'",
    ).run();
    const response = await app.request(
      "https://license.example.test/readiness",
      {},
      testEnv.env,
    );
    expect(response.status).toBe(500);
    const body = await response.json() as any;
    expect(body.error).toMatchObject({
      code: "SETUP_STATE_INCONSISTENT",
      details: {
        status: "inconsistent",
        bootstrap_count: 0,
        user_count: 1,
        instance_count: 1,
        active_instance_count: 1,
        membership_count: 1,
        active_owner_count: 1,
      },
    });
    expectOnlySnakeCaseJsonKeys(body);

    const statusResponse = await app.request(
      "https://license.example.test/status",
      {},
      testEnv.env,
    );
    expect(statusResponse.status).toBe(500);
    const statusBody = await statusResponse.json() as any;
    expect(statusBody.error).toMatchObject({
      code: "SETUP_STATE_INCONSISTENT",
      details: {
        status: "inconsistent",
        bootstrap_count: 0,
        user_count: 1,
        instance_count: 1,
        active_instance_count: 1,
        membership_count: 1,
        active_owner_count: 1,
      },
    });
    expectOnlySnakeCaseJsonKeys(statusBody);
  });

  it("uses deployment bootstrap, not Scheduler state, as initialization evidence", async () => {
    testEnv = createTestEnv({
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    });
    const response = await app.request(
      "https://license.example.test/readiness",
      {},
      testEnv.env,
    );
    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.data.checks.initialized).toBe("not_ready");
    expectOnlySnakeCaseJsonKeys(body);

    const statusResponse = await app.request(
      "https://license.example.test/status",
      {},
      testEnv.env,
    );
    expect(statusResponse.status).toBe(200);
    const statusBody = await statusResponse.json() as any;
    expect(statusBody.data).toMatchObject({ initialized: false });
    expectOnlySnakeCaseJsonKeys(statusBody);
  });
});
