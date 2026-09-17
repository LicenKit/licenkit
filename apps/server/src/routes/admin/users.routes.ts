import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq, and } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { users } from "../../infra/db/schema";
import { hashPassword } from "../../infra/crypto";
import { requireRole } from "../../middleware/auth";
import { AppError, ConflictError, NotFoundError } from "../../middleware/error";

export const adminUsersRouter = new Hono<AppContext>();

// GET /api/v1/admin/users
adminUsersRouter.get("/", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const list = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.accountId, accountId))
    .all();

  return c.json({
    success: true,
    data: {
      items: list,
    },
  });
});

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
  role: z.enum(["admin", "member"]).default("member"),
});

// POST /api/v1/admin/users
adminUsersRouter.post("/", requireRole(["owner", "admin"]), async (c) => {
  const body = await c.req.json();
  const input = CreateUserSchema.parse(body);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email.toLowerCase().trim()))
    .get();

  if (existing) {
    throw new ConflictError("EMAIL_ALREADY_EXISTS", "A user with this email already exists");
  }

  const userId = `usr_${ulid().toLowerCase()}`;
  const passwordHash = await hashPassword(input.password);
  const now = new Date().toISOString();

  await db.insert(users).values({
    id: userId,
    accountId,
    email: input.email.toLowerCase().trim(),
    name: input.name,
    passwordHash,
    role: input.role,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  return c.json(
    {
      success: true,
      data: {
        id: userId,
        email: input.email,
        name: input.name,
        role: input.role,
      },
    },
    201
  );
});

// DELETE /api/v1/admin/users/:id
adminUsersRouter.delete("/:id", requireRole(["owner"]), async (c) => {
  const targetId = c.req.param("id");
  const currentUserId = c.get("userId");

  if (targetId === currentUserId) {
    throw new AppError("CANNOT_DELETE_SELF", "You cannot delete your own user account", 400);
  }

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const target = await db
    .select()
    .from(users)
    .where(and(eq(users.id, targetId), eq(users.accountId, accountId)))
    .get();

  if (!target) {
    throw new NotFoundError("User not found");
  }

  await db.delete(users).where(eq(users.id, targetId));

  return c.json({
    success: true,
    data: {
      message: "User deleted successfully",
    },
  });
});
