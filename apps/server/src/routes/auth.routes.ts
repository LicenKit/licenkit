import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext, InstanceRole } from "../types";
import { verifyPassword } from "../infra/crypto";
import { AppError, UnauthorizedError } from "../middleware/error";
import {
  adminCsrf,
  adminSessionAuth,
  requireAdminAppOrigin,
} from "../middleware/auth";
import {
  clearAdminCookies,
  createSessionSecrets,
  positiveIntegerSetting,
  requestIp,
  setAdminCookies,
} from "../services/identity/session";
import { prepareAuditInsert } from "../services/identity/audit";
import { prepareInitialRecoveryCredential } from "../services/identity/recovery-credential";

export const authRouter = new Hono<AppContext>();
export const adminAuthRouter = authRouter;

const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
}).strict();

interface LoginRow {
  user_id: string;
  email: string;
  password_hash: string;
  name: string;
  instance_id: string;
  instance_name: string;
  instance_site_url: string;
  instance_admin_api_url: string;
  instance_status: string;
  role: InstanceRole;
  membership_status: "active";
}

interface SessionResponseRow {
  user_id: string;
  email: string;
  name: string;
  instance_id: string;
  instance_name: string;
  instance_site_url: string;
  instance_admin_api_url: string;
  instance_status: string;
  role: InstanceRole;
  membership_status: "active";
}

function formatIdentityContext(row: SessionResponseRow) {
  return {
    user: { id: row.user_id, email: row.email, name: row.name },
    instance: {
      id: row.instance_id,
      name: row.instance_name,
      customer_site_url: row.instance_site_url,
      admin_api_url: row.instance_admin_api_url,
      status: row.instance_status,
    },
    membership: { role: row.role, status: row.membership_status },
  };
}

authRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

authRouter.post(
  "/login",
  requireAdminAppOrigin,
  async (c) => {
    const input = LoginSchema.parse(await c.req.json());
    const result = await c.env.DB
      .prepare(
        `WITH active_instance AS (
           SELECT id, name, site_url, admin_api_url, status
           FROM instances
           WHERE status = 'active'
         )
         SELECT u.id AS user_id, u.email, u.password_hash, u.name,
                instance.id AS instance_id, instance.name AS instance_name,
                instance.site_url AS instance_site_url,
                instance.admin_api_url AS instance_admin_api_url,
                instance.status AS instance_status, membership.role,
                membership.status AS membership_status
         FROM users AS u
         JOIN active_instance AS instance ON 1 = 1
         JOIN instance_memberships AS membership
           ON membership.instance_id = instance.id
          AND membership.user_id = u.id
          AND membership.status = 'active'
         WHERE u.email = ?1 COLLATE NOCASE
           AND (SELECT COUNT(*) FROM active_instance) = 1
         LIMIT 1`,
      )
      .bind(input.email.trim().toLowerCase())
      .all<LoginRow>();
    const user = result.results[0];
    if (!user || !(await verifyPassword(input.password, user.password_hash))) {
      throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const ttlSeconds = positiveIntegerSetting(
      c.env.ADMIN_SESSION_TTL_SECONDS,
      604_800,
      "ADMIN_SESSION_TTL_SECONDS",
    );
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const sessionId = `ase_${ulid().toLowerCase()}`;
    const secrets = await createSessionSecrets("adm");
    const recovery = await prepareInitialRecoveryCredential({ db: c.env.DB, userId: user.user_id, now: nowIso,
      request: { requestId: c.get("requestId"), ip: requestIp(c), userAgent: c.req.header("user-agent") } });
    const results = await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO admin_sessions (
             id, user_id, session_token_hash, csrf_token_hash, expires_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(
          sessionId,
          user.user_id,
          secrets.sessionTokenHash,
          secrets.csrfTokenHash,
          expiresAt,
          nowIso,
        ),
      prepareAuditInsert({
        db: c.env.DB,
        scopeType: "identity",
        actor: { type: "user", id: user.user_id },
        action: "identity.login",
        resourceType: "admin_session",
        resourceId: sessionId,
        details: { instance_role: user.role },
        requestId: c.get("requestId"),
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now: nowIso,
      }),
      ...(recovery?.statements ?? []),
    ]);
    setAdminCookies(c, {
      sessionToken: secrets.sessionToken,
      csrfToken: secrets.csrfToken,
      maxAge: ttlSeconds,
    });
    return c.json({
      success: true,
      data: {
        ...formatIdentityContext(user),
        expires_at: expiresAt,
        ...(recovery && Number(results[results.length - 2].meta.changes) === 1
          ? { recovery_credential: recovery.credential } : {}),
      },
    });
  },
);

authRouter.get("/session", adminSessionAuth, async (c) => {
  const instanceId = c.get("instanceId")!;
  const userId = c.get("userId")!;
  const result = await c.env.DB
    .prepare(
      `SELECT u.id AS user_id, u.email, u.name,
              instance.id AS instance_id, instance.name AS instance_name,
              instance.site_url AS instance_site_url,
              instance.admin_api_url AS instance_admin_api_url,
              instance.status AS instance_status, membership.role,
              membership.status AS membership_status
       FROM users AS u
       JOIN instance_memberships AS membership
         ON membership.user_id = u.id
        AND membership.instance_id = ?1
        AND membership.status = 'active'
       JOIN instances AS instance
         ON instance.id = membership.instance_id
        AND instance.status = 'active'
       WHERE u.id = ?2
       LIMIT 1`,
    )
    .bind(instanceId, userId)
    .all<SessionResponseRow>();
  const row = result.results[0];
  if (!row) throw new UnauthorizedError();
  return c.json({ success: true, data: formatIdentityContext(row) });
});

authRouter.post(
  "/logout",
  adminSessionAuth,
  requireAdminAppOrigin,
  adminCsrf,
  async (c) => {
    const now = new Date().toISOString();
    const userId = c.get("userId")!;
    const sessionId = c.get("adminSessionId")!;
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE admin_sessions SET revoked_at = ?1
           WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL`,
        )
        .bind(now, sessionId, userId),
      prepareAuditInsert({
        db: c.env.DB,
        scopeType: "identity",
        actor: { type: "user", id: userId },
        action: "identity.logout",
        resourceType: "admin_session",
        resourceId: sessionId,
        requestId: c.get("requestId"),
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    clearAdminCookies(c);
    return c.json({ success: true, data: { logged_out: true } });
  },
);
