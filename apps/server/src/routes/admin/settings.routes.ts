import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { systemSettings, accounts } from "../../infra/db/schema";
import { encryptEnvelope, decryptEnvelope, getStorageEncryptionKey } from "../../infra/crypto";
import { requireRole } from "../../middleware/auth";
import { NotFoundError, AppError } from "../../middleware/error";
import { recordAuditLog } from "../../infra/audit";

export const adminSettingsRouter = new Hono<AppContext>();

// GET /api/v1/admin/settings
adminSettingsRouter.get("/", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const system = await db.select().from(systemSettings).where(eq(systemSettings.id, "current")).get();
  const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();

  if (!system || !account) {
    throw new NotFoundError("Settings not found");
  }

  // Parse payment config if present (only enabled and webhook_secret are needed)
  type ProviderConfigResponse = { enabled: boolean; webhook_secret_masked: string };
  const paymentConfigsObj: Record<string, ProviderConfigResponse> = {
    paddle: { enabled: false, webhook_secret_masked: "" },
    stripe: { enabled: false, webhook_secret_masked: "" },
    lemonsqueezy: { enabled: false, webhook_secret_masked: "" },
  };

  if (account.paymentConfigs) {
    const encKey = getStorageEncryptionKey(c.env);
    try {
      const decrypted = await decryptEnvelope(account.paymentConfigs, encKey);
      const parsed = JSON.parse(decrypted);
      for (const provider of ["paddle", "stripe", "lemonsqueezy"] as const) {
        if (parsed[provider]) {
          paymentConfigsObj[provider] = {
            enabled: !!parsed[provider].enabled,
            webhook_secret_masked: parsed[provider].webhook_secret
              ? "••••••••" + parsed[provider].webhook_secret.slice(-4)
              : "",
          };
        }
      }
    } catch (e: any) {
      console.error("Failed to decrypt payment configs", e);
      throw new AppError(
        "DECRYPTION_FAILED",
        "Failed to decrypt payment configurations. Ensure STORAGE_ENCRYPTION_KEY matches the one used to encrypt.",
        500
      );
    }
  }

  return c.json({
    success: true,
    data: {
      system: {
        instance_name: system.instanceName,
        app_url: system.appUrl,
        api_base_url: system.apiBaseUrl,
        allow_signup: system.allowSignup,
      },
      account: {
        id: account.id,
        name: account.name,
        slug: account.slug,
        custom_domain: account.customDomain,
        payment_configs: paymentConfigsObj,
      },
    },
  });
});

const GatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  webhook_secret: z.string().optional(),
});

const UpdateSettingsSchema = z.object({
  instance_name: z.string().optional(),
  app_url: z.string().url().optional(),
  api_base_url: z.string().url().optional().nullable(),
  allow_signup: z.boolean().optional(),
  payment_configs: z
    .object({
      paddle: GatewayConfigSchema.optional(),
      stripe: GatewayConfigSchema.optional(),
      lemonsqueezy: GatewayConfigSchema.optional(),
    })
    .optional(),
});

// PUT /api/v1/admin/settings
adminSettingsRouter.put("/", requireRole(["owner", "admin"]), async (c) => {
  const body = await c.req.json();
  const input = UpdateSettingsSchema.parse(body);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const now = new Date().toISOString();

  // 1. Update system settings
  const sysUpdates: Record<string, any> = { updatedAt: now };
  if (input.instance_name !== undefined) sysUpdates.instanceName = input.instance_name;
  if (input.app_url !== undefined) sysUpdates.appUrl = input.app_url.replace(/\/+$/, "");
  if (input.api_base_url !== undefined) {
    sysUpdates.apiBaseUrl = input.api_base_url ? input.api_base_url.replace(/\/+$/, "") : null;
  }
  if (input.allow_signup !== undefined) sysUpdates.allowSignup = input.allow_signup;

  await db.update(systemSettings).set(sysUpdates).where(eq(systemSettings.id, "current"));

  // 2. Update payment configurations if provided
  if (input.payment_configs) {
    const encKey = getStorageEncryptionKey(c.env);

    // Merge with existing configs if present so unmentioned providers or blank secrets aren't overwritten
    let existingConfig: Record<string, any> = {};
    const existingAccount = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (existingAccount?.paymentConfigs) {
      try {
        existingConfig = JSON.parse(await decryptEnvelope(existingAccount.paymentConfigs, encKey));
      } catch (e: any) {
        console.error("Failed to decrypt existing payment configs", e);
        throw new AppError(
          "DECRYPTION_FAILED",
          "Failed to decrypt existing payment configurations. Verify STORAGE_ENCRYPTION_KEY.",
          500
        );
      }
    }

    const merged = { ...existingConfig };
    for (const [provider, conf] of Object.entries(input.payment_configs)) {
      if (conf) {
        merged[provider] = {
          enabled: conf.enabled ?? existingConfig[provider]?.enabled ?? false,
          webhook_secret:
            conf.webhook_secret !== undefined && conf.webhook_secret !== ""
              ? conf.webhook_secret
              : existingConfig[provider]?.webhook_secret || "",
        };
      }
    }

    const encrypted = await encryptEnvelope(JSON.stringify(merged), encKey);
    await db.update(accounts).set({ paymentConfigs: encrypted, updatedAt: now }).where(eq(accounts.id, accountId));
  }

  await recordAuditLog({
    c,
    action: "settings.update",
    resourceType: "settings",
    resourceId: "current",
    details: {
      updatedSystemFields: Object.keys(sysUpdates).filter((k) => k !== "updatedAt"),
      updatedPaymentProviders: input.payment_configs ? Object.keys(input.payment_configs) : [],
    },
  });

  return c.json({
    success: true,
    data: {
      message: "Settings updated successfully",
    },
  });
});

// GET /api/v1/admin/settings/env-check
adminSettingsRouter.get("/env-check", async (c) => {
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
      label: "Storage Master Key (KEK)",
      category: "secret",
      required: true,
      status: storageKeyStatus,
      description: "AES-256-GCM master key protecting payment secrets & Ed25519 private keys in database.",
      fixHint: "Configure in apps/server/.dev.vars (local) or run 'npx wrangler secret put STORAGE_ENCRYPTION_KEY' (production).",
    },
    {
      key: "JWT_SECRET",
      label: "JWT Authentication Secret",
      category: "secret",
      required: true,
      status: jwtSecretStatus,
      description: "HMAC-SHA256 secret for signing and verifying administrator session tokens.",
      fixHint: "Configure in apps/server/.dev.vars (local) or run 'npx wrangler secret put JWT_SECRET' (production).",
    },
    {
      key: "DB",
      label: "Cloudflare D1 Database",
      category: "binding",
      required: true,
      status: env.DB ? "ready" : "missing",
      description: "Relational SQLite database for all platform state.",
      fixHint: "Ensure [[d1_databases]] binding is active in wrangler.jsonc.",
    },
    {
      key: "KEYS_KV",
      label: "Cloudflare KV",
      category: "binding",
      required: false,
      status: env.KEYS_KV ? "ready" : "missing",
      description: "Fast edge cache for client public keys.",
      fixHint: "Ensure kv_namespaces binding is active in wrangler.jsonc.",
    },
    {
      key: "EVENT_QUEUE",
      label: "Cloudflare Queues (Producer)",
      category: "binding",
      required: false,
      status: env.EVENT_QUEUE ? "ready" : "missing",
      description: "Asynchronous delivery pipeline for outbound webhooks.",
      fixHint: "Ensure queues.producers binding is active in wrangler.jsonc.",
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
