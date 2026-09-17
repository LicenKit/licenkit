import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { AppContext } from "../types";
import { getTenantDB } from "../infra/db";
import { systemSettings, accounts, users } from "../infra/db/schema";
import { hashPassword, signJWT } from "../infra/crypto";
import { setupGuard } from "../middleware/auth";
import { AppError } from "../middleware/error";

export const systemRouter = new Hono<AppContext>();

// GET /api/v1/system/status
systemRouter.get("/status", async (c) => {
  const db = getTenantDB(c);
  const current = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.id, "current"))
    .get();

  if (!current) {
    return c.json({
      success: true,
      data: {
        initialized: false,
        version: c.env.APP_VERSION || "1.0.0",
      },
    });
  }

  // If api_base_url is null or empty, default to app_url
  const resolvedApiBaseUrl = current.apiBaseUrl || current.appUrl;

  return c.json({
    success: true,
    data: {
      initialized: true,
      instance_name: current.instanceName,
      app_url: current.appUrl,
      api_base_url: resolvedApiBaseUrl,
      allow_signup: current.allowSignup,
      version: c.env.APP_VERSION || "1.0.0",
    },
  });
});

const SetupSchema = z.object({
  instance_name: z.string().min(1).max(100),
  app_url: z.string().url(),
  api_base_url: z.string().url().optional().nullable(),
  account_name: z.string().min(1).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, "Slug must contain only lowercase alphanumeric and dashes"),
  admin_name: z.string().min(1).max(50),
  admin_email: z.string().email(),
  admin_password: z.string().min(8, "Password must be at least 8 characters"),
});

// POST /api/v1/system/setup
systemRouter.post("/setup", setupGuard, async (c) => {
  const body = await c.req.json();
  const input = SetupSchema.parse(body);

  const db = getTenantDB(c);

  // Check again to avoid race conditions
  const existing = await db
    .select({ id: systemSettings.id })
    .from(systemSettings)
    .where(eq(systemSettings.id, "current"))
    .get();

  if (existing) {
    throw new AppError("INSTANCE_ALREADY_INITIALIZED", "Instance has already been initialized", 403);
  }

  const now = new Date().toISOString();
  const accountId = `acc_${ulid().toLowerCase()}`;
  const userId = `usr_${ulid().toLowerCase()}`;
  const passwordHash = await hashPassword(input.admin_password);

  // Atomic batch write
  await db.batch([
    db.insert(systemSettings).values({
      id: "current",
      instanceName: input.instance_name,
      appUrl: input.app_url.replace(/\/+$/, ""),
      apiBaseUrl: input.api_base_url ? input.api_base_url.replace(/\/+$/, "") : null,
      allowSignup: false,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(accounts).values({
      id: accountId,
      name: input.account_name,
      slug: input.slug,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(users).values({
      id: userId,
      accountId,
      email: input.admin_email.toLowerCase().trim(),
      name: input.admin_name,
      passwordHash,
      role: "owner",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }),
  ]);

  // Sign session JWT
  const jwtSecret = c.env.JWT_SECRET || "licenkit-development-jwt-secret-do-not-use-in-production";
  const sessionToken = await signJWT(
    {
      userId,
      accountId,
      email: input.admin_email.toLowerCase().trim(),
      role: "owner",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7 * 86400, // 7 days
    },
    jwtSecret
  );

  return c.json(
    {
      success: true,
      data: {
        message: "LicenKit instance successfully initialized",
        session_token: sessionToken,
        account: {
          id: accountId,
          name: input.account_name,
          slug: input.slug,
        },
        user: {
          id: userId,
          email: input.admin_email,
          name: input.admin_name,
          role: "owner",
        },
      },
    },
    201
  );
});
