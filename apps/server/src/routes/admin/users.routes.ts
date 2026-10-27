import { Hono } from "hono";
import { z } from "zod";
import type { AppContext, InstanceRole } from "../../types";
import { hashPassword, verifyPassword } from "../../infra/crypto";
import { requireRole } from "../../middleware/auth";
import { AppError, NotFoundError } from "../../middleware/error";
import { prepareAuditInsert } from "../../services/identity/audit";
import { requestIp } from "../../services/identity/session";
import { regenerateRecoveryCredential } from "../../services/identity/recovery-credential";

const ALL_INSTANCE_ROLES: InstanceRole[] = ["owner", "admin", "member", "viewer"];

const UpdateMembershipSchema = z
  .object({
    role: z.enum(["owner", "admin", "member", "viewer"]).optional(),
    status: z.enum(["active", "disabled", "removed"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

const UpdateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1).max(256),
  new_password: z.string().min(12).max(256),
}).strict();

const RecoveryCredentialSchema = z.object({ current_password: z.string().min(1).max(256) }).strict();

interface MemberRow {
  instance_id: string;
  user_id: string;
  role: InstanceRole;
  status: "active" | "disabled" | "removed";
  joined_by_invitation_id: string | null;
  created_at: string;
  updated_at: string;
  user_email: string;
  user_name: string;
  user_created_at: string;
  user_updated_at: string;
}

function formatMember(row: MemberRow) {
  return {
    instance_id: row.instance_id,
    user_id: row.user_id,
    role: row.role,
    status: row.status,
    joined_by_invitation_id: row.joined_by_invitation_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user: {
      id: row.user_id,
      email: row.user_email,
      name: row.user_name,
      created_at: row.user_created_at,
      updated_at: row.user_updated_at,
    },
  };
}

async function readMember(
  db: D1Database,
  instanceId: string,
  userId: string,
): Promise<MemberRow | undefined> {
  const result = await db
    .prepare(
      `SELECT membership.instance_id, membership.user_id, membership.role,
              membership.status, membership.joined_by_invitation_id,
              membership.created_at, membership.updated_at,
              user.email AS user_email, user.name AS user_name,
              user.created_at AS user_created_at, user.updated_at AS user_updated_at
       FROM instance_memberships AS membership
       JOIN users AS user ON user.id = membership.user_id
       WHERE membership.instance_id = ?1 AND membership.user_id = ?2
       LIMIT 1`,
    )
    .bind(instanceId, userId)
    .all<MemberRow>();
  return result.results[0];
}

function databaseFailure(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): AppError {
  const databaseError = error instanceof Error ? error.message : String(error);
  if (databaseError.includes("LAST_ACTIVE_OWNER_REQUIRED")) {
    return new AppError(
      "LAST_ACTIVE_OWNER_REQUIRED",
      "The last active Owner cannot be demoted, disabled, or removed",
      409,
      { database_error: databaseError },
      { database_error: databaseError },
    );
  }
  return new AppError(
    fallbackCode,
    fallbackMessage,
    500,
    { database_error: databaseError },
    { database_error: databaseError },
  );
}

export const adminMembersRouter = new Hono<AppContext>();

adminMembersRouter.get(
  "/",
  requireRole(ALL_INSTANCE_ROLES),
  async (c) => {
    const instanceId = c.get("instanceId")!;
    const result = await c.env.DB
      .prepare(
        `SELECT membership.instance_id, membership.user_id, membership.role,
                membership.status, membership.joined_by_invitation_id,
                membership.created_at, membership.updated_at,
                user.email AS user_email, user.name AS user_name,
                user.created_at AS user_created_at, user.updated_at AS user_updated_at
         FROM instance_memberships AS membership
         JOIN users AS user ON user.id = membership.user_id
         WHERE membership.instance_id = ?1
         ORDER BY CASE membership.status
                    WHEN 'active' THEN 0 WHEN 'disabled' THEN 1 ELSE 2
                  END,
                  CASE membership.role
                    WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                    WHEN 'member' THEN 2 ELSE 3
                  END,
                  user.name COLLATE NOCASE,
                  membership.user_id`,
      )
      .bind(instanceId)
      .all<MemberRow>();
    return c.json({
      success: true,
      data: { items: result.results.map(formatMember) },
    });
  },
);

adminMembersRouter.patch(
  "/:userId",
  requireRole(["owner"]),
  async (c) => {
    const input = UpdateMembershipSchema.parse(await c.req.json());
    const instanceId = c.get("instanceId")!;
    const actorUserId = c.get("userId")!;
    const userId = c.req.param("userId");
    const current = await readMember(c.env.DB, instanceId, userId);
    if (!current) throw new NotFoundError("Instance Membership not found");
    if (current.status === "removed" && input.status === "active") {
      throw new AppError(
        "MEMBERSHIP_REINVITATION_REQUIRED",
        "A removed Membership can only become active by accepting a new Invitation",
        409,
      );
    }

    const nextRole = input.role ?? current.role;
    const nextStatus = input.status ?? current.status;
    const now = new Date().toISOString();
    try {
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            `UPDATE instance_memberships
             SET role = ?1, status = ?2, updated_at = ?3
             WHERE instance_id = ?4 AND user_id = ?5`,
          )
          .bind(nextRole, nextStatus, now, instanceId, userId),
        prepareAuditInsert({
          db: c.env.DB,
          instanceId,
          actor: { type: "user", id: actorUserId },
          action: "instance.membership.updated",
          resourceType: "instance_membership",
          resourceId: userId,
          details: {
            previous: { role: current.role, status: current.status },
            changed: { role: input.role, status: input.status },
          },
          requestId: c.get("requestId"),
          ip: requestIp(c),
          userAgent: c.req.header("user-agent"),
          now,
        }),
      ]);
    } catch (error) {
      throw databaseFailure(
        error,
        "MEMBERSHIP_UPDATE_FAILED",
        "The Instance Membership could not be updated",
      );
    }
    const updated = await readMember(c.env.DB, instanceId, userId);
    if (!updated) throw new NotFoundError("Instance Membership not found");
    return c.json({ success: true, data: formatMember(updated) });
  },
);

export const adminProfileRouter = new Hono<AppContext>();

adminProfileRouter.get(
  "/",
  requireRole(ALL_INSTANCE_ROLES),
  async (c) => {
    const userId = c.get("userId")!;
    const result = await c.env.DB
      .prepare(
        `SELECT id, email, name, created_at, updated_at
         FROM users WHERE id = ?1 LIMIT 1`,
      )
      .bind(userId)
      .all<{
        id: string;
        email: string;
        name: string;
        created_at: string;
        updated_at: string;
      }>();
    const user = result.results[0];
    if (!user) throw new NotFoundError("User not found");
    return c.json({ success: true, data: user });
  },
);

adminProfileRouter.patch(
  "/",
  requireRole(ALL_INSTANCE_ROLES),
  async (c) => {
    const input = UpdateProfileSchema.parse(await c.req.json());
    const userId = c.get("userId")!;
    const currentResult = await c.env.DB
      .prepare(`SELECT id, email, name FROM users WHERE id = ?1 LIMIT 1`)
      .bind(userId)
      .all<{ id: string; email: string; name: string }>();
    const current = currentResult.results[0];
    if (!current) throw new NotFoundError("User not found");
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB
        .prepare(`UPDATE users SET name = ?1, updated_at = ?2 WHERE id = ?3`)
        .bind(input.name, now, userId),
      prepareAuditInsert({
        db: c.env.DB,
        scopeType: "identity",
        actor: { type: "user", id: userId },
        action: "identity.profile.updated",
        resourceType: "user",
        resourceId: userId,
        details: { previous_name: current.name, name: input.name },
        requestId: c.get("requestId"),
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    return c.json({
      success: true,
      data: {
        id: userId,
        email: current.email,
        name: input.name,
        updated_at: now,
      },
    });
  },
);

adminProfileRouter.post(
  "/password",
  requireRole(ALL_INSTANCE_ROLES),
  async (c) => {
    const input = ChangePasswordSchema.parse(await c.req.json());
    const userId = c.get("userId")!;
    const currentSessionId = c.get("adminSessionId")!;
    const currentResult = await c.env.DB
      .prepare(`SELECT password_hash FROM users WHERE id = ?1 LIMIT 1`)
      .bind(userId)
      .all<{ password_hash: string }>();
    const current = currentResult.results[0];
    if (!current || !(await verifyPassword(input.current_password, current.password_hash))) {
      throw new AppError(
        "CURRENT_PASSWORD_INVALID",
        "The current password is invalid",
        400,
      );
    }
    const passwordHash = await hashPassword(input.new_password);
    const now = new Date().toISOString();
    try {
      await c.env.DB.batch([
        c.env.DB
          .prepare(`UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3`)
          .bind(passwordHash, now, userId),
        c.env.DB
          .prepare(
            `UPDATE admin_sessions
             SET revoked_at = ?1
             WHERE user_id = ?2 AND id <> ?3 AND revoked_at IS NULL`,
          )
          .bind(now, userId, currentSessionId),
        prepareAuditInsert({
          db: c.env.DB,
          scopeType: "identity",
          actor: { type: "user", id: userId },
          action: "identity.password.changed",
          resourceType: "user",
          resourceId: userId,
          details: { other_sessions_revoked: true },
          requestId: c.get("requestId"),
          ip: requestIp(c),
          userAgent: c.req.header("user-agent"),
          now,
        }),
      ]);
    } catch (error) {
      throw databaseFailure(
        error,
        "PASSWORD_CHANGE_FAILED",
        "The password could not be changed",
      );
    }
    return c.json({ success: true, data: { password_changed: true } });
  },
);

adminProfileRouter.post("/recovery-credential", requireRole(ALL_INSTANCE_ROLES), async (c) => {
  const input = RecoveryCredentialSchema.parse(await c.req.json());
  const credential = await regenerateRecoveryCredential({ db: c.env.DB, userId: c.get("userId")!,
    currentPassword: input.current_password,
    request: { requestId: c.get("requestId"), ip: requestIp(c), userAgent: c.req.header("user-agent") } });
  return c.json({ success: true, data: { recovery_credential: credential } });
});
