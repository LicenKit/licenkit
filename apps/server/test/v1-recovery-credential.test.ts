import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { sha256Hex, verifyPassword } from "../src/infra/crypto";
import { recoverPasswordWithCredential, regenerateRecoveryCredential } from "../src/services/identity/recovery-credential";
import { consumePasswordReset, requestPasswordReset } from "../src/services/identity/password-reset";
import { decryptEnvelopeV1 } from "../src/infra/delivery/crypto";

const ORIGIN = "https://license.example.test";
const EMAIL = "owner@example.test";
const PASSWORD = "original-password-123";
const NEW_PASSWORD = "recovered-password-123";
const ENDPOINT = "/api/v1/admin/auth/recovery-credential/consume";

describe("Saved administrator recovery credentials", () => {
  let ctx: TestEnvContext;
  let credential: string;
  let userId: string;
  let cookies: string;
  let csrf: string;

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.request(`${ORIGIN}${path}`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.55", ...headers },
      body: JSON.stringify(body),
    }, ctx.env);
  }
  async function recover(value = credential, email = EMAIL) {
    return post(ENDPOINT, { email, recovery_credential: value, new_password: NEW_PASSWORD });
  }
  function credentials() {
    return ctx.sqliteDb.prepare("SELECT * FROM user_recovery_credentials ORDER BY created_at, id").all() as Array<{
      id: string; user_id: string; credential_hash: string; consumed_at: string | null; revoked_at: string | null;
    }>;
  }
  function auditCount() {
    return (ctx.sqliteDb.prepare("SELECT COUNT(*) AS count FROM audit_logs").get() as { count: number }).count;
  }

  beforeEach(async () => {
    // No email or bot-verification configuration exists in this environment.
    ctx = createTestEnv();
    const setup = await post("/api/v1/setup", {
      setup_token: ctx.env.INITIAL_SETUP_TOKEN,
      user: { name: "Owner", email: EMAIL, password: PASSWORD },
      instance: { name: "Test", customer_site_url: "https://site.example.test", admin_api_url: ORIGIN },
    });
    expect(setup.status).toBe(201);
    const payload = await setup.json() as { data: { user: { id: string }; recovery_credential: string } };
    credential = payload.data.recovery_credential; userId = payload.data.user.id;
    const cookieHeader = setup.headers.get("set-cookie") ?? "";
    const sessionCookie = cookieHeader.match(/(__Host-licenkit-admin-session|licenkit_admin_session)=([^;,]+)/)![0];
    const csrfCookie = cookieHeader.match(/(__Host-licenkit-admin-csrf|licenkit_admin_csrf)=([^;,]+)/)![0];
    cookies = `${sessionCookie}; ${csrfCookie}`;
    csrf = csrfCookie.slice(csrfCookie.indexOf("=") + 1);
  });
  afterEach(() => { vi.restoreAllMocks(); ctx.sqliteDb.close() });

  it("issues a credential on initial setup and keeps only a hash", async () => {
    expect(credential).toMatch(/^rcv_[0-9a-f]{64}$/);
    expect(credentials()).toHaveLength(1);
    expect(credentials()[0].credential_hash).toBe(await sha256Hex(credential));
    expect(JSON.stringify(credentials())).not.toContain(credential);
    const session = await app.request(`${ORIGIN}/api/v1/admin/auth/session`, { headers: { Cookie: cookies } }, ctx.env);
    expect((await session.json() as any).data).not.toHaveProperty("recovery_credential");
    const login = await post("/api/v1/admin/auth/login", { email: EMAIL, password: PASSWORD });
    expect((await login.json() as any).data).not.toHaveProperty("recovery_credential");
    expect(credentials()).toHaveLength(1);
    expect(JSON.stringify(ctx.sqliteDb.prepare("SELECT details_redacted_json FROM audit_logs").all())).not.toContain(credential);
  });

  it("issues exactly once when an existing account has two simultaneous first logins", async () => {
    ctx.sqliteDb.prepare("DELETE FROM user_recovery_credentials").run();
    const before = auditCount();
    const responses = await Promise.all([0, 1].map(() => post("/api/v1/admin/auth/login", { email: EMAIL, password: PASSWORD })));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<any>));
    expect(payloads.filter((payload) => payload.data.recovery_credential)).toHaveLength(1);
    expect(credentials()).toHaveLength(1);
    expect(auditCount()).toBe(before + 3); // Two logins, one credential issuance.
  });

  it("recovers without email, replaces the one-use credential, and revokes sessions and links", async () => {
    await requestPasswordReset({ env: ctx.env, email: EMAIL, adminOrigin: ORIGIN, request: {} });
    const response = await recover();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as any;
    const replacement = body.data.recovery_credential;
    expect(replacement).toMatch(/^rcv_[0-9a-f]{64}$/);
    expect(replacement).not.toBe(credential);
    expect(credentials()).toHaveLength(2);
    expect(credentials()[0].consumed_at).not.toBeNull();
    expect(credentials()[1]).toMatchObject({ credential_hash: await sha256Hex(replacement), consumed_at: null, revoked_at: null });
    const user = ctx.sqliteDb.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string };
    expect(await verifyPassword(NEW_PASSWORD, user.password_hash)).toBe(true);
    expect(ctx.sqliteDb.prepare("SELECT COUNT(*) AS count FROM admin_sessions WHERE revoked_at IS NULL").get()).toEqual({ count: 0 });
    expect(ctx.sqliteDb.prepare("SELECT COUNT(*) AS count FROM password_reset_requests WHERE revoked_at IS NULL").get()).toEqual({ count: 0 });
    expect((await recover()).status).toBe(400);
    expect((await recover(replacement)).status).toBe(200);
  });

  it("does not impose the email link expiry on an offline saved credential", async () => {
    ctx.sqliteDb.prepare("UPDATE user_recovery_credentials SET created_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await recover()).status).toBe(200);
  });

  it("rejects a wrong email or credential without any account changes", async () => {
    const before = auditCount();
    for (const [value, email] of [[`rcv_${"0".repeat(64)}`, EMAIL], [credential, "unknown@example.test"]]) {
      const response = await recover(value, email);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "RECOVERY_CREDENTIAL_INVALID" } });
    }
    expect(credentials()).toHaveLength(1);
    expect(credentials()[0].consumed_at).toBeNull();
    expect(auditCount()).toBe(before);
  });

  it("rejects concurrent replay inside the transaction", async () => {
    const before = auditCount();
    const results = await Promise.allSettled([0, 1].map(() => recoverPasswordWithCredential({
      db: ctx.env.DB, email: EMAIL, credential, newPassword: NEW_PASSWORD, request: {},
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.code).toBe("RECOVERY_CREDENTIAL_INVALID");
    expect(credentials()).toHaveLength(2);
    expect(auditCount()).toBe(before + 1);
  });

  it("requires origin, session, CSRF, and the current password before regeneration", async () => {
    const path = "/api/v1/admin/profile/recovery-credential";
    expect((await post(path, { current_password: PASSWORD })).status).toBe(401);
    expect((await post(path, { current_password: PASSWORD }, { Cookie: cookies })).status).toBe(403);
    expect((await post(path, { current_password: PASSWORD }, { Cookie: cookies, "X-CSRF-Token": csrf, Origin: "https://attacker.test" })).status).toBe(403);
    expect((await post(path, { current_password: "incorrect" }, { Cookie: cookies, "X-CSRF-Token": csrf })).status).toBe(400);
    expect(credentials()).toHaveLength(1);
    const response = await post(path, { current_password: PASSWORD }, { Cookie: cookies, "X-CSRF-Token": csrf });
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.recovery_credential).not.toBe(credential);
    expect(credentials()[0].revoked_at).not.toBeNull();
    expect((await recover()).status).toBe(400);
  });

  it("does not regenerate if the verified password changes before the atomic write", async () => {
    const before = auditCount();
    const originalBatch = ctx.env.DB.batch.bind(ctx.env.DB);
    vi.spyOn(ctx.env.DB, "batch").mockImplementationOnce(async (statements) => {
      ctx.sqliteDb.prepare("UPDATE users SET password_hash = 'concurrently-changed', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), userId);
      return originalBatch(statements);
    });
    await expect(regenerateRecoveryCredential({ db: ctx.env.DB, userId, currentPassword: PASSWORD, request: {} }))
      .rejects.toMatchObject({ code: "CURRENT_PASSWORD_INVALID" });
    expect(credentials()).toHaveLength(1);
    expect(credentials()[0].revoked_at).toBeNull();
    expect(auditCount()).toBe(before);
  });

  it("keeps the saved credential after an ordinary password change", async () => {
    const response = await post("/api/v1/admin/profile/password", { current_password: PASSWORD, new_password: NEW_PASSWORD },
      { Cookie: cookies, "X-CSRF-Token": csrf });
    expect(response.status).toBe(200);
    expect(credentials()[0].revoked_at).toBeNull();
    expect((await recover()).status).toBe(200);
  });

  it("keeps the same saved credential after resetting the password by email", async () => {
    const id = (await requestPasswordReset({ env: ctx.env, email: EMAIL, adminOrigin: ORIGIN, request: {} }))!;
    const row = ctx.sqliteDb.prepare("SELECT link_ciphertext FROM password_reset_requests WHERE id = ?").get(id) as { link_ciphertext: string };
    const url = await decryptEnvelopeV1(row.link_ciphertext, ctx.env, {
      scope: "identity", table: "password_reset_requests", rowId: id, field: "link_ciphertext",
    });
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get("token")!;
    await consumePasswordReset({ env: ctx.env, token, newPassword: NEW_PASSWORD, adminOrigin: ORIGIN, request: {} });
    expect(credentials()).toHaveLength(1);
    expect(credentials()[0]).toMatchObject({ credential_hash: await sha256Hex(credential), revoked_at: null, consumed_at: null });
    const login = await post("/api/v1/admin/auth/login", { email: EMAIL, password: NEW_PASSWORD });
    expect((await login.json() as any).data).not.toHaveProperty("recovery_credential");
    expect((await recover()).status).toBe(200);
  });

  it("limits public attempts and validates input without requiring email configuration", async () => {
    for (let index = 0; index < 10; index++) expect((await recover(`rcv_${"0".repeat(64)}`)).status).toBe(400);
    expect((await recover()).status).toBe(429);
    expect((await post(ENDPOINT, { email: EMAIL, recovery_credential: "malformed", new_password: NEW_PASSWORD })).status).toBe(400);
    expect((await post(ENDPOINT, { email: EMAIL, recovery_credential: credential, new_password: NEW_PASSWORD }, { Origin: "https://attacker.test" })).status).toBe(403);
  });
});
