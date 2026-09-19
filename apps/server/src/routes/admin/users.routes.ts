import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext, UserRole } from "../../types";
import { hashPassword } from "../../infra/crypto";
import { adminCsrf, requireExactOrigin, requireRole } from "../../middleware/auth";
import { AppError, ConflictError, NotFoundError } from "../../middleware/error";
import { prepareAuditInsert } from "../../services/identity/audit";
import { requestIp } from "../../services/identity/session";

export const adminUsersRouter = new Hono<AppContext>();

const CreateUserSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(256),
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

const UpdateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["owner", "admin", "member", "viewer"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  password: z.string().min(12).max(256).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

adminUsersRouter.get("/", requireRole(["owner"]), async (c) => {
  const accountId = c.get("accountId")!;
  const result = await c.env.DB
    .prepare(
      `SELECT id, email, name, role, status, created_at, updated_at
       FROM users WHERE account_id = ?1 ORDER BY created_at DESC`
    )
    .bind(accountId)
    .all();
  return c.json({ success: true, data: { items: result.results } });
});

adminUsersRouter.post(
  "/",
  requireExactOrigin,
  adminCsrf,
  requireRole(["owner"]),
  async (c) => {
    const input = CreateUserSchema.parse(await c.req.json());
    const accountId = c.get("accountId")!;
    const actorId = c.get("userId")!;
    const email = input.email.trim().toLowerCase();
    const existing = await c.env.DB
      .prepare(`SELECT id FROM users WHERE account_id = ?1 AND email = ?2 COLLATE NOCASE LIMIT 1`)
      .bind(accountId, email)
      .all<{ id: string }>();
    if (existing.results[0]) throw new ConflictError("EMAIL_ALREADY_EXISTS", "User email already exists");

    const id = `usr_${ulid().toLowerCase()}`;
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(input.password);
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO users (
             id, account_id, email, password_hash, name, role, status, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)`
        )
        .bind(id, accountId, email, passwordHash, input.name, input.role, now),
      prepareAuditInsert({
        db: c.env.DB,
        accountId,
        actor: { type: "user", id: actorId },
        action: "admin.user.created",
        resourceType: "user",
        resourceId: id,
        details: { email, name: input.name, role: input.role },
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    return c.json(
      { success: true, data: { id, email, name: input.name, role: input.role, status: "active" } },
      201
    );
  }
);
adminUsersRouter.patch(
  "/:userId",
  requireExactOrigin,
  adminCsrf,
  requireRole(["owner"]),
  async (c) => {
    const input = UpdateUserSchema.parse(await c.req.json());
    const accountId = c.get("accountId")!;
    const actorId = c.get("userId")!;
    const userId = c.req.param("userId");
    const targetResult = await c.env.DB
      .prepare(`SELECT id, email, name, role, status FROM users WHERE account_id = ?1 AND id = ?2 LIMIT 1`)
      .bind(accountId, userId)
      .all<{ id: string; email: string; name: string; role: UserRole; status: "active" | "disabled" }>();
    const target = targetResult.results[0];
    if (!target) throw new NotFoundError("User not found");

    const removesActiveOwner =
      target.role === "owner" &&
      target.status === "active" &&
      (input.role !== undefined && input.role !== "owner" || input.status === "disabled");
    if (removesActiveOwner) {
      const ownerCount = await c.env.DB
        .prepare(
          `SELECT COUNT(*) AS count FROM users
           WHERE account_id = ?1 AND role = 'owner' AND status = 'active' AND id <> ?2`
        )
        .bind(accountId, userId)
        .all<{ count: number }>();
      if (Number(ownerCount.results[0]?.count ?? 0) === 0) {
        throw new AppError("LAST_ACTIVE_OWNER_REQUIRED", "The last active owner cannot be disabled or demoted", 409);
      }
    }

    const now = new Date().toISOString();
    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      assignments.push(`${column} = ?${values.length + 1}`);
      values.push(value);
    };
    if (input.name !== undefined) add("name", input.name);
    if (input.role !== undefined) add("role", input.role);
    if (input.status !== undefined) add("status", input.status);
    if (input.password !== undefined) add("password_hash", await hashPassword(input.password));
    add("updated_at", now);
    const accountPlaceholder = values.length + 1;
    const userPlaceholder = values.length + 2;
    const statements: D1PreparedStatement[] = [
      c.env.DB
        .prepare(
          `UPDATE users SET ${assignments.join(", ")}
           WHERE account_id = ?${accountPlaceholder} AND id = ?${userPlaceholder}`
        )
        .bind(...values, accountId, userId),
    ];
    if (input.status === "disabled" || input.password !== undefined) {
      statements.push(
        c.env.DB
          .prepare(
            `UPDATE admin_sessions SET revoked_at = ?1
             WHERE account_id = ?2 AND user_id = ?3 AND revoked_at IS NULL`
          )
          .bind(now, accountId, userId)
      );
    }
    statements.push(
      prepareAuditInsert({
        db: c.env.DB,
        accountId,
        actor: { type: "user", id: actorId },
        action: "admin.user.updated",
        resourceType: "user",
        resourceId: userId,
        details: {
          previous: { name: target.name, role: target.role, status: target.status },
          changed: {
            name: input.name,
            role: input.role,
            status: input.status,
            passwordChanged: input.password !== undefined,
          },
        },
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      })
    );
    await c.env.DB.batch(statements);
    const updated = await c.env.DB
      .prepare(`SELECT id, email, name, role, status, created_at, updated_at FROM users WHERE account_id = ?1 AND id = ?2`)
      .bind(accountId, userId)
      .all();
    return c.json({ success: true, data: updated.results[0] });
  }
);

adminUsersRouter.post(
  "/:userId/sessions/revoke",
  requireExactOrigin,
  adminCsrf,
  requireRole(["owner"]),
  async (c) => {
    const accountId = c.get("accountId")!;
    const actorId = c.get("userId")!;
    const userId = c.req.param("userId");
    const exists = await c.env.DB
      .prepare(`SELECT id FROM users WHERE account_id = ?1 AND id = ?2 LIMIT 1`)
      .bind(accountId, userId)
      .all<{ id: string }>();
    if (!exists.results[0]) throw new NotFoundError("User not found");
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE admin_sessions SET revoked_at = ?1
           WHERE account_id = ?2 AND user_id = ?3 AND revoked_at IS NULL`
        )
        .bind(now, accountId, userId),
      prepareAuditInsert({
        db: c.env.DB,
        accountId,
        actor: { type: "user", id: actorId },
        action: "admin.user.sessions_revoked",
        resourceType: "user",
        resourceId: userId,
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    return c.json({ success: true, data: { revoked: true } });
  }
);
