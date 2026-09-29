import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/types";
import { sha256Hex } from "../src/infra/crypto";
import { errorHandler } from "../src/middleware/error";
import { adminSystemIssuesRouter } from "../src/routes/admin/system-issues.routes";
import { adminStatsRouter } from "../src/routes/admin/stats.routes";
import { prepareSystemIssueUpsert } from "../src/services/operations/system-issues";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const ORIGIN = "https://license.example.test";
const INSTANCE_ID = "acc_system_issue";
const USER_ID = "usr_system_issue_owner";
const CSRF_TOKEN = "acf_system_issue_test_token";
const FIRST_SEEN = "2026-09-20T10:00:00.000Z";

describe("System Issue manual handling workflow", () => {
  let testEnv: TestEnvContext;
  let app: Hono<AppContext>;

  beforeEach(() => {
    testEnv = createTestEnv();
    testEnv.sqliteDb.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES (?, 'System Issue', 'https://system-issue.example.test', 'https://license.example.test', 'active', ?, ?)`,
    ).run(INSTANCE_ID, FIRST_SEEN, FIRST_SEEN);
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (
         id, email, password_hash, name, created_at, updated_at
       ) VALUES (?, 'owner@example.test', 'hash', 'Owner', ?, ?)`,
    ).run(USER_ID, FIRST_SEEN, FIRST_SEEN);

    app = new Hono<AppContext>();
    app.onError(errorHandler);
    app.use("*", async (c, next) => {
      c.set("requestId", "req_system_issue");
      c.set("instanceId", INSTANCE_ID);
      c.set("userId", USER_ID);
      c.set("instanceRole", "owner");
      c.set("userEmail", "owner@example.test");
      c.set("sessionNamespace", "admin");
      c.set("sessionCsrfTokenHash", await sha256Hex(CSRF_TOKEN));
      await next();
    });
    app.route("/system", adminSystemIssuesRouter);
    app.route("/stats", adminStatsRouter);
  });

  function mutationInit(): RequestInit {
    return {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "X-CSRF-Token": CSRF_TOKEN,
        Cookie: `__Host-licenkit-admin-csrf=${CSRF_TOKEN}`,
      },
    };
  }

  async function record(nowIso: string, detail: string): Promise<void> {
    await prepareSystemIssueUpsert({
      db: testEnv.d1,
      instanceId: INSTANCE_ID,
      category: "email",
      sourceType: "email_delivery",
      sourceId: "dly_system_issue",
      operation: "customer.license_issued",
      errorCode: "EMAIL_PROVIDER_REJECTED",
      errorDetailJson: JSON.stringify({ detail, providerRequestId: "req_provider" }),
      nowIso,
    }).run();
  }

  it("moves pending to processed and reopens it when the same error happens again", async () => {
    await record(FIRST_SEEN, "first");
    const issue = testEnv.sqliteDb.prepare(
      "SELECT id FROM system_issues WHERE instance_id = ?",
    ).get(INSTANCE_ID) as { id: string };

    const listResponse = await app.request(`${ORIGIN}/system/issues`, {}, testEnv.env);
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as any;
    expect(listBody.data.items[0]).toMatchObject({
      id: issue.id,
      source_type: "email_delivery",
      source_id: "dly_system_issue",
      error_code: "EMAIL_PROVIDER_REJECTED",
      occurrence_count: 1,
      error: { detail: "first", provider_request_id: "req_provider" },
    });
    expect(JSON.stringify(listBody)).not.toMatch(/"[a-z]+[A-Z][A-Za-z]*":/);
    const pendingStats = await app.request(`${ORIGIN}/stats`, {}, testEnv.env);
    expect((await pendingStats.json() as any).data.pending_system_issues).toBe(1);

    const processedResponse = await app.request(
      `${ORIGIN}/system/issues/${issue.id}/process`,
      mutationInit(),
      testEnv.env,
    );
    expect(processedResponse.status).toBe(200);
    const processedBody = await processedResponse.json() as any;
    expect(processedBody).toMatchObject({
      data: { id: issue.id, status: "processed", processed_at: expect.any(String) },
    });
    expect(JSON.stringify(processedBody)).not.toMatch(/"[a-z]+[A-Z][A-Za-z]*":/);
    const processedStats = await app.request(`${ORIGIN}/stats`, {}, testEnv.env);
    expect((await processedStats.json() as any).data.pending_system_issues).toBe(0);
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, occurrence_count, processed_by_user_id,
              processed_at, error_detail_json
       FROM system_issues WHERE id = ?`,
    ).get(issue.id)).toMatchObject({
      status: "processed",
      occurrence_count: 1,
      processed_by_user_id: USER_ID,
      processed_at: expect.any(String),
      error_detail_json: JSON.stringify({ detail: "first", providerRequestId: "req_provider" }),
    });

    await record("2026-09-20T11:00:00.000Z", "second");
    expect(testEnv.sqliteDb.prepare(
      `SELECT id, status, occurrence_count, processed_by_user_id,
              processed_at, error_detail_json, last_seen_at
       FROM system_issues WHERE id = ?`,
    ).get(issue.id)).toEqual({
      id: issue.id,
      status: "pending",
      occurrence_count: 2,
      processed_by_user_id: null,
      processed_at: null,
      error_detail_json: JSON.stringify({ detail: "second", providerRequestId: "req_provider" }),
      last_seen_at: "2026-09-20T11:00:00.000Z",
    });
  });
});
