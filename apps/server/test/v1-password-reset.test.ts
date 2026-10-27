import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { decryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { sha256Hex, verifyPassword } from "../src/infra/crypto";
import { consumePasswordReset, dispatchPasswordReset, runPasswordResetScheduler } from "../src/services/identity/password-reset";

const ORIGIN = "https://license.example.test";
const AUTH = "/api/v1/admin/auth";
const EMAIL = "owner@example.test";
const PASSWORD = "original-password-123";
const NEW_PASSWORD = "replacement-password-123";

describe("Administrator password recovery", () => {
  let ctx: TestEnvContext;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalCookie: string;

  async function post(path: string, body: unknown, origin = ORIGIN) {
    return app.request(`${ORIGIN}${path}`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.1" },
      body: JSON.stringify(body),
    }, ctx.env);
  }
  async function request(email = EMAIL) {
    return post(`${AUTH}/password-reset/request`, { email, turnstile_token: "valid-challenge" });
  }
  function rows() {
    return ctx.sqliteDb.prepare("SELECT * FROM password_reset_requests ORDER BY created_at, id").all() as Array<{
      id: string; user_id: string; token_hash: string; link_ciphertext: string | null;
      expires_at: string; consumed_at: string | null; revoked_at: string | null; send_status: string;
      attempt_count: number; next_attempt_at: string; last_error_code: string | null;
    }>;
  }
  async function tokenFor(id: string) {
    const row = rows().find((item) => item.id === id)!;
    const url = await decryptEnvelopeV1(row.link_ciphertext!, ctx.env, {
      scope: "identity", table: "password_reset_requests", rowId: id, field: "link_ciphertext",
    });
    return new URLSearchParams(new URL(url).hash.slice(1)).get("token")!;
  }
  function allowAnotherRequest() {
    ctx.sqliteDb.prepare("DELETE FROM identity_request_limits").run();
  }
  async function consume(token: string) {
    return post(`${AUTH}/password-reset/consume`, { token, new_password: NEW_PASSWORD });
  }

  beforeEach(async () => {
    ctx = createTestEnv({
      TURNSTILE_SITE_KEY: "test-site-key", TURNSTILE_SECRET_KEY: "test-site-secret",
      IDENTITY_EMAIL_API_KEY: "re_identity_test_secret", IDENTITY_EMAIL_FROM: "LicenKit <accounts@example.test>",
      IDENTITY_PASSWORD_RESET_TEMPLATE: "account-password-reset-v1",
    });
    fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      String(url).includes("siteverify") ? { success: true, action: "admin_password_reset", hostname: "license.example.test" }
      : { id: "mail_reset_1" },
    ), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const setup = await post("/api/v1/setup", {
      setup_token: ctx.env.INITIAL_SETUP_TOKEN,
      user: { name: "Owner", email: EMAIL, password: PASSWORD },
      instance: { name: "Test", customer_site_url: "https://site.example.test", admin_api_url: ORIGIN },
    });
    expect(setup.status).toBe(201);
    originalCookie = (setup.headers.get("set-cookie") ?? "").match(/(__Host-licenkit-admin-session|licenkit_admin_session)=([^;,]+)/)![0];
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); ctx.sqliteDb.close() });

  it("exposes public config, keeps unknown emails indistinguishable, and stores only encrypted links", async () => {
    const config = await app.request(`${ORIGIN}${AUTH}/password-reset/config`, {}, ctx.env);
    expect(config.headers.get("cache-control")).toBe("no-store");
    expect(await config.json()).toEqual({ success: true, data: { turnstile_site_key: "test-site-key", turnstile_action: "admin_password_reset" } });
    const existing = await request(" OWNER@EXAMPLE.TEST ");
    const unknown = await request("unknown@example.test");
    expect(existing.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await existing.json()).toEqual(await unknown.json());
    expect(rows()).toHaveLength(1);
    const row = rows()[0];
    const token = await tokenFor(row.id);
    expect(row.token_hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(ctx.sqliteDb.prepare("SELECT COUNT(*) AS count FROM email_deliveries").get()).toEqual({ count: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // Only Siteverify; sending is durable background work.
  });

  it("rejects missing shared email configuration for every account before lookup", async () => {
    delete ctx.env.IDENTITY_PASSWORD_RESET_TEMPLATE;
    for (const email of [EMAIL, "unknown@example.test"]) {
      const response = await request(email);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "PASSWORD_RESET_UNAVAILABLE" } });
    }
    expect(rows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the exact origin and challenge action and hostname", async () => {
    expect((await post(`${AUTH}/password-reset/request`, { email: EMAIL, turnstile_token: "challenge" }, "https://attacker.test")).status).toBe(403);
    for (const result of [
      { success: true, action: "customer_magic_link", hostname: "license.example.test" },
      { success: true, action: "admin_password_reset", hostname: "attacker.test" },
      { success: false, action: "admin_password_reset", hostname: "license.example.test" },
    ]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result)));
      expect((await request()).status).toBe(400);
    }
    expect(rows()).toHaveLength(0);
  });

  it("enforces cooldown and IP limits without revealing the account", async () => {
    expect((await request()).status).toBe(202);
    expect((await request()).status).toBe(202);
    expect(rows()).toHaveLength(1);
    for (let index = 0; index < 10; index++) expect((await request(`absent${index}@example.test`)).status).toBe(202);
    expect(ctx.sqliteDb.prepare("SELECT MAX(request_count) AS count FROM identity_request_limits").get()).toEqual({ count: 10 });
    expect(rows()).toHaveLength(1);
  });

  it("sends through deployment account mail and removes the encrypted payload after acceptance", async () => {
    await request();
    const row = rows()[0];
    const token = await tokenFor(row.id);
    await runPasswordResetScheduler(ctx.env);
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("api.resend.com"))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.to).toBe(EMAIL);
    expect(body.template.id).toBe("account-password-reset-v1");
    expect(body.template.variables.reset_url).toBe(`${ORIGIN}/admin/reset-password#token=${token}`);
    expect(rows()[0]).toMatchObject({ send_status: "accepted", link_ciphertext: null, attempt_count: 1 });
    await runPasswordResetScheduler(ctx.env);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("api.resend.com"))).toHaveLength(1);
  });

  it("records a permanent missing-template failure without exposing secrets in logs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await request();
    const token = await tokenFor(rows()[0].id);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: "not_found", message: `Missing template: ${token}` }), { status: 404 }));
    await runPasswordResetScheduler(ctx.env);
    expect(rows()[0]).toMatchObject({ send_status: "failed", link_ciphertext: null });
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(EMAIL);
  });

  it("persists transient failures for retry and recovers an expired send lease", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await request();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "Try later" }), { status: 429 }));
    await runPasswordResetScheduler(ctx.env);
    expect(rows()[0]).toMatchObject({ send_status: "pending", attempt_count: 1 });
    await dispatchPasswordReset(ctx.env, rows()[0].id, new Date(Date.parse(rows()[0].next_attempt_at) + 1));
    expect(rows()[0].send_status).toBe("accepted");
    allowAnotherRequest(); await request();
    const second = rows()[1];
    ctx.sqliteDb.prepare("UPDATE password_reset_requests SET send_status = 'processing', locked_until = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), second.id);
    await runPasswordResetScheduler(ctx.env);
    expect(rows()[1].send_status).toBe("accepted");
  });

  it("atomically changes the password, revokes all logins, and rejects replay", async () => {
    await post(`${AUTH}/login`, { email: EMAIL, password: PASSWORD });
    await request(); const token = await tokenFor(rows()[0].id);
    const response = await consume(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { password_reset: true } });
    expect(rows()[0].consumed_at).not.toBeNull();
    const user = ctx.sqliteDb.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
    expect(await verifyPassword(NEW_PASSWORD, user.password_hash)).toBe(true);
    expect(ctx.sqliteDb.prepare("SELECT COUNT(*) AS count FROM admin_sessions WHERE revoked_at IS NULL").get()).toEqual({ count: 0 });
    expect((await app.request(`${ORIGIN}${AUTH}/session`, { headers: { Cookie: originalCookie } }, ctx.env)).status).toBe(401);
    expect((await post(`${AUTH}/login`, { email: EMAIL, password: PASSWORD })).status).toBe(401);
    expect((await post(`${AUTH}/login`, { email: EMAIL, password: NEW_PASSWORD })).status).toBe(200);
    expect((await consume(token)).status).toBe(400);
  });

  it("permits only one concurrent consumer and rolls back the losing batch", async () => {
    await request(); const token = await tokenFor(rows()[0].id);
    const before = ctx.sqliteDb.prepare("SELECT COUNT(*) AS count FROM audit_logs").get() as { count: number };
    const results = await Promise.allSettled([0, 1].map(() => consumePasswordReset({ env: ctx.env, token, newPassword: NEW_PASSWORD, adminOrigin: ORIGIN, request: {} })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.code).toBe("PASSWORD_RESET_LINK_INVALID");
    expect(ctx.sqliteDb.prepare("SELECT COUNT(*) AS count FROM audit_logs").get()).toEqual({ count: before.count + 1 });
  });

  it("can consume an issued link even when email configuration later becomes unavailable", async () => {
    await request(); const token = await tokenFor(rows()[0].id);
    delete ctx.env.IDENTITY_EMAIL_API_KEY;
    expect((await consume(token)).status).toBe(200);
    expect(ctx.sqliteDb.prepare("SELECT password_hash_at_request FROM password_reset_requests").get())
      .toEqual({ password_hash_at_request: "" });
  });

  it("invalidates old links on reissue or a normal password change", async () => {
    await request(); const firstToken = await tokenFor(rows()[0].id);
    allowAnotherRequest(); await request();
    expect(rows()[0]).toMatchObject({ send_status: "cancelled", link_ciphertext: null });
    expect((await consume(firstToken)).status).toBe(400);
    const secondToken = await tokenFor(rows()[1].id);
    ctx.sqliteDb.prepare("UPDATE users SET password_hash = 'changed', updated_at = ?").run(new Date().toISOString());
    expect(rows()[1].revoked_at).not.toBeNull();
    expect((await consume(secondToken)).status).toBe(400);
  });

  it("rejects expired and unknown links and clears expired sensitive payloads", async () => {
    await request(); const token = await tokenFor(rows()[0].id);
    ctx.sqliteDb.prepare("UPDATE password_reset_requests SET expires_at = ?").run(new Date(Date.now() - 1_000).toISOString());
    expect((await consume(token)).status).toBe(400);
    expect((await consume(`prk_${"0".repeat(64)}`)).status).toBe(400);
    expect((await post(`${AUTH}/password-reset/consume`, { token, new_password: "short" })).status).toBe(400);
    await runPasswordResetScheduler(ctx.env);
    expect(rows()[0]).toMatchObject({ send_status: "expired", link_ciphertext: null });
    expect(ctx.sqliteDb.prepare("SELECT password_hash FROM users").get()).not.toEqual({ password_hash: NEW_PASSWORD });
  });
});
