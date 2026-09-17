import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppContext } from "../types";
import { getTenantDB } from "../infra/db";
import { users, accounts } from "../infra/db/schema";
import { verifyPassword, signJWT } from "../infra/crypto";
import { sessionAuth } from "../middleware/auth";
import { UnauthorizedError } from "../middleware/error";

export const authRouter = new Hono<AppContext>();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /api/v1/auth/login
authRouter.post("/login", async (c) => {
  const body = await c.req.json();
  const input = LoginSchema.parse(body);

  const db = getTenantDB(c);
  const user = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email.toLowerCase().trim()))
    .get();

  if (!user || !user.isActive) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const passwordValid = await verifyPassword(input.password, user.passwordHash);
  if (!passwordValid) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const account = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, user.accountId))
    .get();

  if (!account || !account.isActive) {
    throw new UnauthorizedError("Tenant account is suspended or disabled");
  }

  const jwtSecret = c.env.JWT_SECRET || "licenkit-development-jwt-secret-do-not-use-in-production";
  const sessionToken = await signJWT(
    {
      userId: user.id,
      accountId: user.accountId,
      email: user.email,
      role: user.role as "owner" | "admin" | "member",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7 * 86400,
    },
    jwtSecret
  );

  return c.json({
    success: true,
    data: {
      session_token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      account: {
        id: account.id,
        name: account.name,
        slug: account.slug,
        custom_domain: account.customDomain,
      },
    },
  });
});

// GET /api/v1/auth/me
authRouter.get("/me", sessionAuth, async (c) => {
  const db = getTenantDB(c);
  const userId = c.get("userId")!;
  const accountId = c.get("accountId")!;

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();

  if (!user || !account) {
    throw new UnauthorizedError("User or account not found");
  }

  return c.json({
    success: true,
    data: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      account: {
        id: account.id,
        name: account.name,
        slug: account.slug,
        custom_domain: account.customDomain,
      },
    },
  });
});

// POST /api/v1/auth/logout
authRouter.post("/logout", sessionAuth, async (c) => {
  return c.json({
    success: true,
    data: {
      message: "Logged out successfully",
    },
  });
});
