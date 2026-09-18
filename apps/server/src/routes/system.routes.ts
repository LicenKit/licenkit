import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { AppContext } from "../types";
import { getTenantDB } from "../infra/db";
import { systemSettings, accounts, users } from "../infra/db/schema";
import { hashPassword, signJWT, getJwtSecret, getStorageEncryptionKey } from "../infra/crypto";
import { setupGuard } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { rateLimit } from "../middleware/rate-limit";

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

// GET /api/v1/system/env-check
systemRouter.get("/env-check", async (c) => {
  const env = c.env;
  const storageKey = env.STORAGE_ENCRYPTION_KEY?.trim() || "";
  const jwtSec = env.JWT_SECRET?.trim() || "";

  const storageKeyStatus = !storageKey
    ? "missing"
    : storageKey.length < 16
    ? "insecure"
    : "ready";

  const jwtSecretStatus = !jwtSec
    ? "missing"
    : jwtSec.length < 16
    ? "insecure"
    : "ready";

  const items = [
    {
      key: "STORAGE_ENCRYPTION_KEY",
      label: "Storage Encryption Key (KEK)",
      category: "secret",
      required: true,
      status: storageKeyStatus,
      description: "AES-256-GCM master key protecting payment webhook secrets & Ed25519 private keys in database.",
      fixHint: "Add STORAGE_ENCRYPTION_KEY to apps/server/.dev.vars (local) or run 'npx wrangler secret put STORAGE_ENCRYPTION_KEY' (production).",
    },
    {
      key: "JWT_SECRET",
      label: "JWT Session Secret",
      category: "secret",
      required: true,
      status: jwtSecretStatus,
      description: "HMAC-SHA256 secret for signing and verifying administrator login session tokens.",
      fixHint: "Add JWT_SECRET to apps/server/.dev.vars (local) or run 'npx wrangler secret put JWT_SECRET' (production).",
    },
    {
      key: "DB",
      label: "Cloudflare D1 Database",
      category: "binding",
      required: true,
      status: env.DB ? "ready" : "missing",
      description: "Relational database binding for multi-tenant licensing engine.",
      fixHint: "Ensure [[d1_databases]] binding is configured in wrangler.jsonc.",
    },
    {
      key: "KEYS_KV",
      label: "Cloudflare KV Namespace",
      category: "binding",
      required: false,
      status: env.KEYS_KV ? "ready" : "missing",
      description: "Edge read-only KV namespace for public keys and fast lookup.",
      fixHint: "Configure kv_namespaces binding in wrangler.jsonc if edge key caching is needed.",
    },
    {
      key: "EVENT_QUEUE",
      label: "Cloudflare Queues (Producer)",
      category: "binding",
      required: false,
      status: env.EVENT_QUEUE ? "ready" : "missing",
      description: "Asynchronous queue pipeline for outbound webhook broadcasting and retries.",
      fixHint: "Configure queues.producers binding in wrangler.jsonc.",
    },
  ];

  const allReady = items.filter((i) => i.required).every((i) => i.status === "ready");

  return c.json({
    success: true,
    data: {
      environment: env.ENVIRONMENT || "development",
      version: env.APP_VERSION || "1.0.0",
      all_ready: allReady,
      items,
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
systemRouter.post(
  "/setup",
  setupGuard,
  rateLimit({ limit: 5, windowSeconds: 600, keyPrefix: "system_setup" }),
  async (c) => {
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

    try {
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
    } catch (err: any) {
      if (
        err?.message?.includes("UNIQUE") ||
        err?.message?.includes("PRIMARYKEY") ||
        err?.message?.includes("constraint") ||
        err?.message?.includes("already exists")
      ) {
        throw new AppError("INSTANCE_ALREADY_INITIALIZED", "Instance has already been initialized", 403);
      }
      throw err;
    }

  // Early check: Ensure STORAGE_ENCRYPTION_KEY and JWT_SECRET are valid
  getStorageEncryptionKey(c.env);
  const jwtSecret = getJwtSecret(c.env);
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
