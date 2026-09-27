import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppContext, InstanceRole } from "../src/types";
import { hashPassword, sha256Hex, verifyPassword } from "../src/infra/crypto";
import { decryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { errorHandler } from "../src/middleware/error";
import { adminInstanceRouter } from "../src/routes/admin/settings.routes";
import {
  adminMembersRouter,
  adminProfileRouter,
} from "../src/routes/admin/users.routes";
import {
  adminInvitationsRouter,
  invitationRouter,
} from "../src/routes/invitation.routes";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
} from "../src/services/identity/session";
import {
  buildTrustedFragmentUrl,
  createOneTimeLinkSecret,
} from "../src/services/identity/one-time-link";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const ORIGIN = "https://license.example.test";
const CUSTOMER_SITE_URL = "https://site.example.test/customer";
const INSTANCE_ID = "ins_membership_test";
const OWNER_ID = "usr_owner";
const OWNER_EMAIL = "owner@example.test";
const OWNER_PASSWORD = "owner-password-123";
const CSRF_TOKEN = "acf_membership_invitation_test";
const NOW = "2026-09-21T01:00:00.000Z";

function adminApp(role: InstanceRole = "owner") {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_membership_test");
    c.set("instanceId", INSTANCE_ID);
    c.set("userId", OWNER_ID);
    c.set("userEmail", OWNER_EMAIL);
    c.set("instanceRole", role);
    c.set("adminSessionId", "ase_current");
    c.set("sessionNamespace", "admin");
    c.set("sessionCsrfTokenHash", await sha256Hex(CSRF_TOKEN));
    await next();
  });
  app.route("/instance", adminInstanceRouter);
  app.route("/members", adminMembersRouter);
  app.route("/invitations", adminInvitationsRouter);
  app.route("/profile", adminProfileRouter);
  return app;
}

function publicInvitationApp() {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_invitation_accept");
    await next();
  });
  app.route("/invitations", invitationRouter);
  return app;
}

function requestInit(method = "GET", body?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: {
      Origin: ORIGIN,
      "X-CSRF-Token": CSRF_TOKEN,
      Cookie: `${ADMIN_CSRF_COOKIE}=${CSRF_TOKEN}`,
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function json(response: Response): Promise<any> {
  return response.json() as Promise<any>;
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

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${name}=([^;,]+)`));
  if (!match) throw new Error(`Cookie ${name} was not set: ${header}`);
  return match[1];
}

async function invitationUrlFor(testEnv: TestEnvContext, invitationId: string): Promise<string> {
  const row = testEnv.sqliteDb.prepare(
    `SELECT invitation.delivery_id, delivery.variables_ciphertext
     FROM instance_invitations AS invitation
     JOIN email_deliveries AS delivery
       ON delivery.instance_id = invitation.instance_id
      AND delivery.id = invitation.delivery_id
     WHERE invitation.id = ?`,
  ).get(invitationId) as { delivery_id: string; variables_ciphertext: string };
  const variables = JSON.parse(await decryptEnvelopeV1(
    row.variables_ciphertext,
    testEnv.env,
    {
      instanceId: INSTANCE_ID,
      table: "email_deliveries",
      rowId: row.delivery_id,
      field: "variables_ciphertext",
    },
  ));
  return variables.invitation_url;
}

async function tokenForInvitation(testEnv: TestEnvContext, invitationId: string): Promise<string> {
  return new URL(await invitationUrlFor(testEnv, invitationId)).hash.slice("#token=".length);
}

async function createInvitation(
  testEnv: TestEnvContext,
  email: string,
  role: InstanceRole = "member",
) {
  const response = await adminApp().request(
    `${ORIGIN}/invitations`,
    requestInit("POST", { email, role }),
    testEnv.env,
  );
  expect(response.status).toBe(201);
  const payload = await json(response);
  expectOnlySnakeCaseJsonKeys(payload);
  return payload.data;
}

describe("Instance, Membership, Profile and Invitation API", () => {
  let testEnv: TestEnvContext;

  beforeEach(async () => {
    testEnv = createTestEnv({ ENVIRONMENT: "test" });
    const ownerHash = await hashPassword(OWNER_PASSWORD);
    testEnv.sqliteDb.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES (?, 'Membership Test', ?, ?, 'active', ?, ?)`,
    ).run(INSTANCE_ID, CUSTOMER_SITE_URL, ORIGIN, NOW, NOW);
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES (?, ?, ?, 'Owner', ?, ?)`,
    ).run(OWNER_ID, OWNER_EMAIL, ownerHash, NOW, NOW);
    testEnv.sqliteDb.prepare(
      `INSERT INTO instance_memberships (
         instance_id, user_id, role, status, joined_by_invitation_id, created_at, updated_at
       ) VALUES (?, ?, 'owner', 'active', NULL, ?, ?)`,
    ).run(INSTANCE_ID, OWNER_ID, NOW, NOW);
    testEnv.sqliteDb.prepare(
      `INSERT INTO admin_sessions (
         id, user_id, session_token_hash, csrf_token_hash, expires_at, created_at
       ) VALUES ('ase_current', ?, 'session-current', ?, '2099-01-01T00:00:00.000Z', ?),
                ('ase_other', ?, 'session-other', 'csrf-other', '2099-01-01T00:00:00.000Z', ?)`,
    ).run(OWNER_ID, await sha256Hex(CSRF_TOKEN), NOW, OWNER_ID, NOW);
  });

  it("shares password-strength token hashing and trusted Fragment URL construction", async () => {
    const secret = await createOneTimeLinkSecret("ivk");
    expect(secret.token).toMatch(/^ivk_[0-9a-f]{64}$/);
    expect(secret.tokenHash).toBe(await sha256Hex(secret.token));
    expect(secret.tokenHash).not.toContain(secret.token);
    const url = buildTrustedFragmentUrl({
      trustedUrl: `${ORIGIN}/customer/site`,
      path: "/admin/invitations/accept",
      token: secret.token,
    });
    expect(url).toBe(`${ORIGIN}/admin/invitations/accept#token=${secret.token}`);
    expect(new URL(url).search).toBe("");
  });

  it("returns the read-only Instance and keeps all Member filtering in SQL", async () => {
    const app = adminApp("viewer");
    const instance = await app.request(`${ORIGIN}/instance`, requestInit(), testEnv.env);
    expect(instance.status).toBe(200);
    const instancePayload = await json(instance);
    expectOnlySnakeCaseJsonKeys(instancePayload);
    expect(instancePayload.data).toMatchObject({
      id: INSTANCE_ID,
      name: "Membership Test",
      customer_site_url: CUSTOMER_SITE_URL,
      admin_api_url: ORIGIN,
      status: "active",
    });
    const members = await app.request(`${ORIGIN}/members`, requestInit(), testEnv.env);
    const membersPayload = await json(members);
    expectOnlySnakeCaseJsonKeys(membersPayload);
    expect(membersPayload.data.items).toEqual([
      expect.objectContaining({
        instance_id: INSTANCE_ID,
        user_id: OWNER_ID,
        role: "owner",
        status: "active",
        user: expect.objectContaining({ email: OWNER_EMAIL, name: "Owner" }),
      }),
    ]);
  });

  it("creates Invitation + encrypted waiting Delivery + audit atomically without returning the token", async () => {
    const invitation = await createInvitation(testEnv, "Invitee@Example.Test", "admin");
    expect(invitation).toMatchObject({
      instance_id: INSTANCE_ID,
      email: "invitee@example.test",
      role: "admin",
      status: "pending",
      delivery: { status: "waiting_configuration" },
    });
    expect(JSON.stringify(invitation)).not.toContain("ivk_");
    const row = testEnv.sqliteDb.prepare(
      `SELECT invitation.token_hash, delivery.variables_ciphertext, delivery.status,
              audit.action
       FROM instance_invitations AS invitation
       JOIN email_deliveries AS delivery ON delivery.id = invitation.delivery_id
       JOIN audit_logs AS audit ON audit.resource_id = invitation.id
       WHERE invitation.id = ?`,
    ).get(invitation.id) as any;
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.status).toBe("waiting_configuration");
    expect(row.variables_ciphertext).not.toContain("ivk_");
    expect(row.action).toBe("instance.invitation.created");
    expect(await invitationUrlFor(testEnv, invitation.id)).toMatch(
      /^https:\/\/license\.example\.test\/admin\/invitations\/accept#token=ivk_[0-9a-f]{64}$/,
    );
    const token = await tokenForInvitation(testEnv, invitation.id);
    expect(await sha256Hex(token)).toBe(row.token_hash);
  });

  it("creates an Admin invitation link on non-production localhost HTTP", async () => {
    const localAdminOrigin = "http://localhost:8787";
    testEnv.env.ENVIRONMENT = "development";
    testEnv.sqliteDb.prepare(
      "UPDATE instances SET admin_api_url = ? WHERE id = ?",
    ).run(localAdminOrigin, INSTANCE_ID);

    const response = await adminApp().request(
      `${localAdminOrigin}/invitations`,
      requestInit(
        "POST",
        { email: "localhost-invitee@example.test", role: "member" },
        { Origin: localAdminOrigin },
      ),
      testEnv.env,
    );

    expect(response.status).toBe(201);
    const invitation = (await json(response)).data;
    expect(await invitationUrlFor(testEnv, invitation.id)).toMatch(
      /^http:\/\/localhost:8787\/admin\/invitations\/accept#token=ivk_[0-9a-f]{64}$/,
    );
  });

  it.each([
    ["a non-loopback development host", "http://license.example.test", "development"],
    ["an IPv6 loopback development host", "http://[::1]:8787", "development"],
    ["production localhost", "http://localhost:8787", "production"],
  ])("rejects Admin invitation links configured with %s HTTP", async (
    _case,
    adminOrigin,
    environment,
  ) => {
    testEnv.env.ENVIRONMENT = environment;
    testEnv.sqliteDb.prepare(
      "UPDATE instances SET admin_api_url = ? WHERE id = ?",
    ).run(adminOrigin, INSTANCE_ID);

    const response = await adminApp().request(
      `${adminOrigin}/invitations`,
      requestInit(
        "POST",
        { email: "rejected-http@example.test", role: "member" },
        { Origin: adminOrigin },
      ),
      testEnv.env,
    );

    expect(response.status).toBe(500);
    expect((await json(response)).error.code).toBe("ONE_TIME_LINK_TRUSTED_URL_INVALID");
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM instance_invitations",
    ).get()).toEqual({ count: 0 });
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM email_deliveries",
    ).get()).toEqual({ count: 0 });
  });

  it("accepts a new User once and rolls back every losing concurrent batch", async () => {
    const invitation = await createInvitation(testEnv, "new-user@example.test", "member");
    const token = await tokenForInvitation(testEnv, invitation.id);
    const app = publicInvitationApp();
    const body = {
      token,
      new_user: { name: "New User", password: "new-user-password-123" },
    };
    const responses = await Promise.all([
      app.request(`${ORIGIN}/invitations/accept`, requestInit("POST", body), testEnv.env),
      app.request(`${ORIGIN}/invitations/accept`, requestInit("POST", body), testEnv.env),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([200, 409]);
    const accepted = responses.find((item) => item.status === 200)!;
    const payload = await json(accepted);
    expectOnlySnakeCaseJsonKeys(payload);
    expect(payload.data).toMatchObject({
      user: { email: "new-user@example.test", name: "New User" },
      instance: { id: INSTANCE_ID },
      membership: { role: "member", status: "active" },
    });
    expect(accepted.headers.get("set-cookie")).toContain(ADMIN_SESSION_COOKIE);
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE email = 'new-user@example.test'",
    ).get()).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM admin_sessions WHERE user_id <> ?",
    ).get(OWNER_ID)).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, accepted_by_user_id FROM instance_invitations WHERE id = ?",
    ).get(invitation.id)).toMatchObject({ status: "accepted" });
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, variables_ciphertext FROM email_deliveries WHERE id = ?",
    ).get(invitation.delivery.id)).toEqual({ status: "cancelled", variables_ciphertext: null });
  });

  it("requires existing User credentials and uses a new Invitation to rejoin removed Membership", async () => {
    const first = await createInvitation(testEnv, "returning@example.test", "viewer");
    const firstToken = await tokenForInvitation(testEnv, first.id);
    const publicApp = publicInvitationApp();
    const firstAccept = await publicApp.request(
      `${ORIGIN}/invitations/accept`,
      requestInit("POST", {
        token: firstToken,
        new_user: { name: "Returning", password: "returning-password-123" },
      }),
      testEnv.env,
    );
    expect(firstAccept.status).toBe(200);
    const returningId = (await json(firstAccept)).data.user.id;
    const removed = await adminApp().request(
      `${ORIGIN}/members/${returningId}`,
      requestInit("PATCH", { status: "removed" }),
      testEnv.env,
    );
    expect(removed.status).toBe(200);
    const directRestore = await adminApp().request(
      `${ORIGIN}/members/${returningId}`,
      requestInit("PATCH", { status: "active" }),
      testEnv.env,
    );
    expect((await json(directRestore)).error.code).toBe("MEMBERSHIP_REINVITATION_REQUIRED");

    const second = await createInvitation(testEnv, "returning@example.test", "admin");
    const secondToken = await tokenForInvitation(testEnv, second.id);
    const wrongPassword = await publicApp.request(
      `${ORIGIN}/invitations/accept`,
      requestInit("POST", {
        token: secondToken,
        existing_user: { email: "returning@example.test", password: "wrong-password" },
      }),
      testEnv.env,
    );
    expect(wrongPassword.status).toBe(401);
    const accepted = await publicApp.request(
      `${ORIGIN}/invitations/accept`,
      requestInit("POST", {
        token: secondToken,
        existing_user: {
          email: "RETURNING@example.test",
          password: "returning-password-123",
        },
      }),
      testEnv.env,
    );
    expect(accepted.status).toBe(200);
    expect(testEnv.sqliteDb.prepare(
      `SELECT role, status, joined_by_invitation_id
       FROM instance_memberships WHERE instance_id = ? AND user_id = ?`,
    ).get(INSTANCE_ID, returningId)).toEqual({
      role: "admin",
      status: "active",
      joined_by_invitation_id: second.id,
    });
  });

  it("accepts token-only with a valid global Session after the Membership was removed", async () => {
    const first = await createInvitation(testEnv, "session-rejoin@example.test", "viewer");
    const firstToken = await tokenForInvitation(testEnv, first.id);
    const publicApp = publicInvitationApp();
    const firstAccept = await publicApp.request(
      `${ORIGIN}/invitations/accept`,
      requestInit("POST", {
        token: firstToken,
        new_user: { name: "Session Rejoin", password: "session-rejoin-password-123" },
      }),
      testEnv.env,
    );
    expect(firstAccept.status).toBe(200);
    const acceptedPayload = await json(firstAccept);
    const returningUserId = acceptedPayload.data.user.id;
    const sessionToken = cookieValue(firstAccept, ADMIN_SESSION_COOKIE);
    const csrfToken = cookieValue(firstAccept, ADMIN_CSRF_COOKIE);
    const sessionCountBefore = testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM admin_sessions WHERE user_id = ?",
    ).get(returningUserId);

    const removed = await adminApp().request(
      `${ORIGIN}/members/${returningUserId}`,
      requestInit("PATCH", { status: "removed" }),
      testEnv.env,
    );
    expect(removed.status).toBe(200);
    const second = await createInvitation(testEnv, "session-rejoin@example.test", "admin");
    const secondToken = await tokenForInvitation(testEnv, second.id);

    const rejoined = await publicApp.request(
      `${ORIGIN}/invitations/accept`,
      requestInit(
        "POST",
        { token: secondToken },
        {
          Cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`,
          "X-CSRF-Token": csrfToken,
        },
      ),
      testEnv.env,
    );
    expect(rejoined.status).toBe(200);
    const rejoinedPayload = await json(rejoined);
    expectOnlySnakeCaseJsonKeys(rejoinedPayload);
    expect(rejoinedPayload.data).toMatchObject({
      user: { id: returningUserId, email: "session-rejoin@example.test" },
      instance: {
        id: INSTANCE_ID,
        customer_site_url: CUSTOMER_SITE_URL,
        admin_api_url: ORIGIN,
      },
      membership: { role: "admin", status: "active" },
    });
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM admin_sessions WHERE user_id = ?",
    ).get(returningUserId)).toEqual(sessionCountBefore);
    expect(testEnv.sqliteDb.prepare(
      `SELECT role, status, joined_by_invitation_id
       FROM instance_memberships WHERE instance_id = ? AND user_id = ?`,
    ).get(INSTANCE_ID, returningUserId)).toEqual({
      role: "admin",
      status: "active",
      joined_by_invitation_id: second.id,
    });
  });

  it("lets exactly one accept-vs-revoke batch commit without loser side effects", async () => {
    const invitation = await createInvitation(testEnv, "race@example.test", "member");
    const token = await tokenForInvitation(testEnv, invitation.id);
    const originalBatch = testEnv.d1.batch.bind(testEnv.d1);
    let releaseFirstBatch: (() => void) | undefined;
    let batchCalls = 0;
    testEnv.d1.batch = async (statements: any[]) => {
      batchCalls += 1;
      if (batchCalls === 1) {
        await new Promise<void>((resolve) => { releaseFirstBatch = resolve; });
      } else if (batchCalls === 2) {
        releaseFirstBatch?.();
      }
      return originalBatch(statements);
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const [accept, revoke] = await Promise.all([
      publicInvitationApp().request(
        `${ORIGIN}/invitations/accept`,
        requestInit("POST", {
          token,
          new_user: { name: "Race User", password: "race-user-password-123" },
        }),
        testEnv.env,
      ),
      adminApp().request(
        `${ORIGIN}/invitations/${invitation.id}/revoke`,
        requestInit("POST"),
        testEnv.env,
      ),
    ]);
    testEnv.d1.batch = originalBatch;
    expect([accept.status, revoke.status].sort()).toEqual([200, 409]);
    const loser = accept.status === 409 ? accept : revoke;
    const loserError = (await json(loser)).error;
    expectOnlySnakeCaseJsonKeys({ error: loserError });
    expect(loserError.code).toBe("INSTANCE_INVITATION_ALREADY_FINALIZED");
    expect(loserError.details.database_error).toContain("INSTANCE_INVITATION_ALREADY_FINALIZED");

    const terminal = testEnv.sqliteDb.prepare(
      "SELECT status, accepted_by_user_id FROM instance_invitations WHERE id = ?",
    ).get(invitation.id) as { status: "accepted" | "revoked"; accepted_by_user_id: string | null };
    const userCount = testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE email = 'race@example.test'",
    ).get() as { count: number };
    const membershipCount = testEnv.sqliteDb.prepare(
      `SELECT COUNT(*) AS count FROM instance_memberships AS membership
       JOIN users AS user ON user.id = membership.user_id
       WHERE membership.instance_id = ? AND user.email = 'race@example.test'`,
    ).get(INSTANCE_ID) as { count: number };
    const sessionCount = testEnv.sqliteDb.prepare(
      `SELECT COUNT(*) AS count FROM admin_sessions AS session
       JOIN users AS user ON user.id = session.user_id
       WHERE user.email = 'race@example.test'`,
    ).get() as { count: number };
    if (terminal.status === "accepted") {
      expect({ userCount, membershipCount, sessionCount }).toEqual({
        userCount: { count: 1 },
        membershipCount: { count: 1 },
        sessionCount: { count: 1 },
      });
      expect(terminal.accepted_by_user_id).toBeTruthy();
    } else {
      expect({ userCount, membershipCount, sessionCount }).toEqual({
        userCount: { count: 0 },
        membershipCount: { count: 0 },
        sessionCount: { count: 0 },
      });
      expect(terminal.accepted_by_user_id).toBeNull();
    }
    expect(testEnv.sqliteDb.prepare(
      `SELECT COUNT(*) AS count FROM audit_logs
       WHERE resource_id = ?
         AND action IN ('instance.invitation.accepted', 'instance.invitation.revoked')`,
    ).get(invitation.id)).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare(
      `SELECT COUNT(*) AS count FROM email_deliveries
       WHERE id = ? AND status = 'cancelled' AND variables_ciphertext IS NULL`,
    ).get(invitation.delivery.id)).toEqual({ count: 1 });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(token);
  });

  it("revokes and resends by database-guarded terminal transitions with a fresh token", async () => {
    const original = await createInvitation(testEnv, "resend@example.test", "member");
    const originalToken = await tokenForInvitation(testEnv, original.id);
    const resentResponse = await adminApp().request(
      `${ORIGIN}/invitations/${original.id}/resend`,
      requestInit("POST"),
      testEnv.env,
    );
    expect(resentResponse.status).toBe(201);
    const resent = (await json(resentResponse)).data;
    expectOnlySnakeCaseJsonKeys({ data: resent });
    const resentToken = await tokenForInvitation(testEnv, resent.id);
    expect(resent.id).not.toBe(original.id);
    expect(resentToken).not.toBe(originalToken);
    expect(testEnv.sqliteDb.prepare(
      "SELECT status FROM instance_invitations WHERE id = ?",
    ).get(original.id)).toEqual({ status: "revoked" });

    const oldAccept = await publicInvitationApp().request(
      `${ORIGIN}/invitations/accept`,
      requestInit("POST", {
        token: originalToken,
        new_user: { name: "Old Link", password: "old-link-password-123" },
      }),
      testEnv.env,
    );
    expect(oldAccept.status).toBe(400);
    const revoked = await adminApp().request(
      `${ORIGIN}/invitations/${resent.id}/revoke`,
      requestInit("POST"),
      testEnv.env,
    );
    expect(revoked.status).toBe(200);
    const repeated = await adminApp().request(
      `${ORIGIN}/invitations/${resent.id}/revoke`,
      requestInit("POST"),
      testEnv.env,
    );
    expect(repeated.status).toBe(409);
    const repeatedPayload = await json(repeated);
    expectOnlySnakeCaseJsonKeys(repeatedPayload);
    expect(repeatedPayload.error).toMatchObject({
      code: "INSTANCE_INVITATION_ALREADY_FINALIZED",
      details: expect.objectContaining({ database_error: expect.stringContaining("INSTANCE_INVITATION_ALREADY_FINALIZED") }),
    });
  });

  it("lets a User change only its own Profile and atomically revokes every other Session", async () => {
    const app = adminApp("viewer");
    const update = await app.request(
      `${ORIGIN}/profile`,
      requestInit("PATCH", { name: "Renamed Owner" }),
      testEnv.env,
    );
    expect(update.status).toBe(200);
    const updatePayload = await json(update);
    expectOnlySnakeCaseJsonKeys(updatePayload);
    expect(updatePayload.data).toMatchObject({ name: "Renamed Owner", updated_at: expect.any(String) });
    const password = await app.request(
      `${ORIGIN}/profile/password`,
      requestInit("POST", {
        current_password: OWNER_PASSWORD,
        new_password: "changed-owner-password-123",
      }),
      testEnv.env,
    );
    expect(password.status).toBe(200);
    const passwordPayload = await json(password);
    expectOnlySnakeCaseJsonKeys(passwordPayload);
    expect(passwordPayload.data).toEqual({ password_changed: true });
    const sessions = testEnv.sqliteDb.prepare(
      "SELECT id, revoked_at FROM admin_sessions WHERE user_id = ? ORDER BY id",
    ).all(OWNER_ID) as Array<{ id: string; revoked_at: string | null }>;
    expect(sessions.find((row) => row.id === "ase_current")?.revoked_at).toBeNull();
    expect(sessions.find((row) => row.id === "ase_other")?.revoked_at).not.toBeNull();
    const user = testEnv.sqliteDb.prepare(
      "SELECT name, password_hash FROM users WHERE id = ?",
    ).get(OWNER_ID) as { name: string; password_hash: string };
    expect(user.name).toBe("Renamed Owner");
    expect(await verifyPassword("changed-owner-password-123", user.password_hash)).toBe(true);
    expect(testEnv.sqliteDb.prepare(
      `SELECT COUNT(*) AS count FROM audit_logs
       WHERE scope_type = 'identity' AND action IN ('identity.profile.updated', 'identity.password.changed')`,
    ).get()).toEqual({ count: 2 });
  });

  it("lets the database reject removal of the final active Owner inside the audit batch", async () => {
    const response = await adminApp().request(
      `${ORIGIN}/members/${OWNER_ID}`,
      requestInit("PATCH", { status: "removed" }),
      testEnv.env,
    );
    expect(response.status).toBe(409);
    const payload = await json(response);
    expectOnlySnakeCaseJsonKeys(payload);
    expect(payload.error.code).toBe("LAST_ACTIVE_OWNER_REQUIRED");
    expect(payload.error.details.database_error).toContain("LAST_ACTIVE_OWNER_REQUIRED");
    expect(testEnv.sqliteDb.prepare(
      "SELECT role, status FROM instance_memberships WHERE user_id = ?",
    ).get(OWNER_ID)).toEqual({ role: "owner", status: "active" });
    expect(testEnv.sqliteDb.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'instance.membership.updated'",
    ).get()).toEqual({ count: 0 });
  });

  it("rejects camelCase aliases and exposes request_id as the only request identifier", async () => {
    const profileAlias = await adminApp("viewer").request(
      `${ORIGIN}/profile/password`,
      requestInit("POST", {
        currentPassword: OWNER_PASSWORD,
        newPassword: "changed-owner-password-123",
      }),
      testEnv.env,
    );
    expect(profileAlias.status).toBe(400);
    const profileError = await json(profileAlias);
    expectOnlySnakeCaseJsonKeys(profileError);
    expect(profileError.error.request_id).toBe("req_membership_test");
    expect(profileError.error).not.toHaveProperty("requestId");

    const invitationAlias = await publicInvitationApp().request(
      `${ORIGIN}/invitations/accept`,
      requestInit("POST", {
        token: `ivk_${"a".repeat(64)}`,
        existingUser: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      }),
      testEnv.env,
    );
    expect(invitationAlias.status).toBe(400);
    const invitationError = await json(invitationAlias);
    expectOnlySnakeCaseJsonKeys(invitationError);
    expect(invitationError.error.request_id).toBe("req_invitation_accept");
    expect(invitationError.error).not.toHaveProperty("requestId");
  });
});
