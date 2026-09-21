import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppContext, InstanceRole } from "../types";
import { sha256Hex } from "../infra/crypto";
import {
  adminCsrf,
  requireAdminAppOrigin,
  requireRole,
} from "../middleware/auth";
import { UnauthorizedError } from "../middleware/error";
import {
  readAdminCookies,
  requestIp,
  setAdminCookies,
} from "../services/identity/session";
import {
  acceptInstanceInvitation,
  createInstanceInvitation,
  listInstanceInvitations,
  resendInstanceInvitation,
  revokeInstanceInvitation,
} from "../services/identity/invitation";

const ALL_INSTANCE_ROLES: InstanceRole[] = ["owner", "admin", "member", "viewer"];

const InvitationIdSchema = z.string().regex(/^ivi_[0-9a-hjkmnp-tv-z]{26}$/);
const CreateInvitationSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(["owner", "admin", "member", "viewer"]),
}).strict();

const AcceptInvitationSchema = z.union([
  z.object({
    token: z.string().regex(/^ivk_[0-9a-f]{64}$/),
  }).strict(),
  z.object({
    token: z.string().regex(/^ivk_[0-9a-f]{64}$/),
    existing_user: z.object({
      email: z.string().email().max(320),
      password: z.string().min(1).max(256),
    }).strict(),
  }).strict(),
  z.object({
    token: z.string().regex(/^ivk_[0-9a-f]{64}$/),
    new_user: z.object({
      name: z.string().trim().min(1).max(120),
      password: z.string().min(12).max(256),
    }).strict(),
  }).strict(),
]);

function requestContext(c: {
  get(name: "requestId"): string;
  req: { header(name: string): string | undefined };
}) {
  return {
    requestId: c.get("requestId"),
    ip: requestIp(c as any),
    userAgent: c.req.header("user-agent"),
  };
}

/**
 * Invitation acceptance needs only a valid global User Session. It must not
 * require an active Membership: a removed User may retain a valid global
 * Session and use a new Invitation to rejoin the Instance.
 */
async function authenticateInvitationIdentitySession(
  c: Context<AppContext>,
): Promise<void> {
  const cookies = readAdminCookies(c);
  if (!cookies.sessionToken) {
    throw new UnauthorizedError("Administrator session cookie is missing");
  }
  const sessionTokenHash = await sha256Hex(cookies.sessionToken);
  const now = new Date().toISOString();
  const result = await c.env.DB
    .prepare(
      `SELECT session.id AS session_id, session.csrf_token_hash,
              user.id AS user_id, user.email
       FROM admin_sessions AS session
       JOIN users AS user ON user.id = session.user_id
       WHERE session.session_token_hash = ?1
         AND session.revoked_at IS NULL
         AND session.expires_at > ?2
       LIMIT 1`,
    )
    .bind(sessionTokenHash, now)
    .all<{
      session_id: string;
      csrf_token_hash: string;
      user_id: string;
      email: string;
    }>();
  const session = result.results[0];
  if (!session) throw new UnauthorizedError("Administrator session is invalid or expired");
  c.set("userId", session.user_id);
  c.set("userEmail", session.email);
  c.set("adminSessionId", session.session_id);
  c.set("sessionCsrfTokenHash", session.csrf_token_hash);
  c.set("sessionNamespace", "admin");
  await c.env.DB
    .prepare(
      `UPDATE admin_sessions SET last_seen_at = ?1
       WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL`,
    )
    .bind(now, session.session_id, session.user_id)
    .run();
}

export const adminInvitationsRouter = new Hono<AppContext>();

adminInvitationsRouter.get(
  "/",
  requireRole(ALL_INSTANCE_ROLES),
  async (c) => {
    const items = await listInstanceInvitations({
      db: c.env.DB,
      instanceId: c.get("instanceId")!,
    });
    return c.json({ success: true, data: { items } });
  },
);

adminInvitationsRouter.post(
  "/",
  requireRole(["owner"]),
  async (c) => {
    const input = CreateInvitationSchema.parse(await c.req.json());
    const invitation = await createInstanceInvitation({
      db: c.env.DB,
      env: c.env,
      instanceId: c.get("instanceId")!,
      actorUserId: c.get("userId")!,
      adminOrigin: new URL(c.req.url).origin,
      email: input.email,
      role: input.role,
      request: requestContext(c),
    });
    return c.json({ success: true, data: invitation }, 201);
  },
);

adminInvitationsRouter.post(
  "/:invitationId/revoke",
  requireRole(["owner"]),
  async (c) => {
    const invitationId = InvitationIdSchema.parse(c.req.param("invitationId"));
    const invitation = await revokeInstanceInvitation({
      db: c.env.DB,
      instanceId: c.get("instanceId")!,
      invitationId,
      actorUserId: c.get("userId")!,
      request: requestContext(c),
    });
    return c.json({ success: true, data: invitation });
  },
);

adminInvitationsRouter.post(
  "/:invitationId/resend",
  requireRole(["owner"]),
  async (c) => {
    const invitationId = InvitationIdSchema.parse(c.req.param("invitationId"));
    const invitation = await resendInstanceInvitation({
      db: c.env.DB,
      env: c.env,
      instanceId: c.get("instanceId")!,
      invitationId,
      actorUserId: c.get("userId")!,
      adminOrigin: new URL(c.req.url).origin,
      request: requestContext(c),
    });
    return c.json({ success: true, data: invitation }, 201);
  },
);

export const invitationRouter = new Hono<AppContext>();

invitationRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

invitationRouter.post(
  "/accept",
  requireAdminAppOrigin,
  async (c) => {
    const input = AcceptInvitationSchema.parse(await c.req.json());
    let mode:
      | { kind: "session"; userId: string; userEmail: string; sessionId: string }
      | { kind: "existing_user"; email: string; password: string }
      | { kind: "new_user"; name: string; password: string };
    if ("existing_user" in input) {
      mode = {
        kind: "existing_user",
        email: input.existing_user.email,
        password: input.existing_user.password,
      };
    } else if ("new_user" in input) {
      mode = {
        kind: "new_user",
        name: input.new_user.name,
        password: input.new_user.password,
      };
    } else {
      await authenticateInvitationIdentitySession(c);
      await adminCsrf(c, async () => {});
      mode = {
        kind: "session",
        userId: c.get("userId")!,
        userEmail: c.get("userEmail")!,
        sessionId: c.get("adminSessionId")!,
      };
    }
    const accepted = await acceptInstanceInvitation({
      db: c.env.DB,
      env: c.env,
      token: input.token,
      mode,
      request: requestContext(c),
    });
    if (accepted.cookies) {
      setAdminCookies(c, accepted.cookies);
    }
    return c.json({ success: true, data: accepted.session });
  },
);
