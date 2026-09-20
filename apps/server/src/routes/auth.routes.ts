import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext, UserRole } from "../types";
import { verifyPassword } from "../infra/crypto";
import { UnauthorizedError } from "../middleware/error";
import {
  adminCsrf,
  adminSessionAuth,
  requireExactOrigin,
} from "../middleware/auth";
import {
  clearAdminCookies,
  createSessionSecrets,
  positiveIntegerSetting,
  requestIp,
  setAdminCookies,
} from "../services/identity/session";
import { prepareAuditInsert } from "../services/identity/audit";

export const authRouter = new Hono<AppContext>();
export const adminAuthRouter = authRouter;

const LoginSchema = z.object({
  accountSlug: z.string().trim().toLowerCase().min(1).max(63),
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

interface LoginRow {
  user_id: string;
  account_id: string;
  account_name: string;
  account_slug: string;
  email: string;
  password_hash: string;
  name: string;
  role: UserRole;
}

authRouter.post(
  "/login",
  requireExactOrigin,
  async (c) => {
    const input = LoginSchema.parse(await c.req.json());
    const result = await c.env.DB
      .prepare(
        `SELECT u.id AS user_id, u.account_id, a.name AS account_name,
                a.slug AS account_slug, u.email, u.password_hash, u.name, u.role
         FROM users AS u
         JOIN accounts AS a ON a.id = u.account_id
         WHERE a.slug = ?1 AND u.email = ?2 COLLATE NOCASE
           AND a.status = 'active' AND u.status = 'active'
         LIMIT 1`
      )
      .bind(input.accountSlug, input.email.trim().toLowerCase())
      .all<LoginRow>();
    const user = result.results[0];
    if (!user || !(await verifyPassword(input.password, user.password_hash))) {
      throw new UnauthorizedError("Invalid account, email, or password");
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const ttlSeconds = positiveIntegerSetting(
      (c.env as any).ADMIN_SESSION_TTL_SECONDS,
      604_800,
      "ADMIN_SESSION_TTL_SECONDS"
    );
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const sessionId = `ase_${ulid().toLowerCase()}`;
    const secrets = await createSessionSecrets("adm");
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO admin_sessions (
             id, account_id, user_id, session_token_hash, csrf_token_hash,
             expires_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
        .bind(
          sessionId,
          user.account_id,
          user.user_id,
          secrets.sessionTokenHash,
          secrets.csrfTokenHash,
          expiresAt,
          nowIso
        ),
      prepareAuditInsert({
        db: c.env.DB,
        accountId: user.account_id,
        actor: { type: "user", id: user.user_id },
        action: "admin.auth.login",
        resourceType: "admin_session",
        resourceId: sessionId,
        details: { role: user.role },
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now: nowIso,
      }),
    ]);
    setAdminCookies(c, {
      accountId: user.account_id,
      sessionToken: secrets.sessionToken,
      csrfToken: secrets.csrfToken,
      maxAge: ttlSeconds,
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: {
        user: { id: user.user_id, email: user.email, name: user.name, role: user.role },
        account: { id: user.account_id, name: user.account_name, slug: user.account_slug },
        expiresAt,
      },
    });
  }
);

authRouter.get("/session", adminSessionAuth, async (c) => {
  const accountId = c.get("accountId")!;
  const userId = c.get("userId")!;
  const result = await c.env.DB
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, a.name AS account_name, a.slug AS account_slug
       FROM users AS u JOIN accounts AS a ON a.id = u.account_id
       WHERE u.account_id = ?1 AND u.id = ?2
       LIMIT 1`
    )
    .bind(accountId, userId)
    .all<any>();
  const row = result.results[0];
  if (!row) throw new UnauthorizedError();
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: {
      user: { id: row.id, email: row.email, name: row.name, role: row.role },
      account: { id: accountId, name: row.account_name, slug: row.account_slug },
    },
  });
});

authRouter.post(
  "/logout",
  adminSessionAuth,
  requireExactOrigin,
  adminCsrf,
  async (c) => {
    const now = new Date().toISOString();
    const accountId = c.get("accountId")!;
    const userId = c.get("userId")!;
    const sessionId = (c as any).get("adminSessionId") as string;
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE admin_sessions SET revoked_at = ?1
           WHERE account_id = ?2 AND id = ?3 AND revoked_at IS NULL`
        )
        .bind(now, accountId, sessionId),
      prepareAuditInsert({
        db: c.env.DB,
        accountId,
        actor: { type: "user", id: userId },
        action: "admin.auth.logout",
        resourceType: "admin_session",
        resourceId: sessionId,
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    clearAdminCookies(c);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: { loggedOut: true } });
  }
);
