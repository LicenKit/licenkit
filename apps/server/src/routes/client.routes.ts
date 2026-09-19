import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../types";
import { activateLicense, deactivateActivation, validateActivation } from "../services/license/activation";
import { claimTrial, enforceTrialClaimRateLimit, validateTrial } from "../services/license/trial";
import { rateLimit } from "../middleware/rate-limit";

export const clientRouter = new Hono<AppContext>();

const ReleaseFields = {
  release_version: z.string().trim().min(1).max(100),
  release_platform: z.string().trim().min(1).max(100),
};

const ActivateSchema = z.object({
  account_id: z.string().min(1),
  product_id: z.string().min(1),
  license_key: z.string().min(16).max(200),
  fingerprint: z.string().trim().min(8).max(512),
  device_platform: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  ...ReleaseFields,
}).strict();

clientRouter.post("/activate", rateLimit({ limit: 30, windowSeconds: 60, keyPrefix: "client_activate" }), async (c) => {
  const input = ActivateSchema.parse(await c.req.json());
  const data = await activateLicense({
    db: c.env.DB,
    env: c.env,
    accountId: input.account_id,
    productId: input.product_id,
    licenseKey: input.license_key,
    fingerprint: input.fingerprint,
    devicePlatform: input.device_platform,
    name: input.name,
    releaseVersion: input.release_version,
    releasePlatform: input.release_platform,
    firstIp: c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
  });
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data });
});

const ValidateSchema = z.object({
  account_id: z.string().min(1),
  product_id: z.string().min(1),
  activation_id: z.string().min(1),
  machine_token: z.string().min(16),
  fingerprint: z.string().trim().min(8).max(512),
  device_platform: z.string().trim().min(1).max(100).optional(),
  ...ReleaseFields,
}).strict();

clientRouter.post("/validate", rateLimit({ limit: 120, windowSeconds: 60, keyPrefix: "client_validate" }), async (c) => {
  const input = ValidateSchema.parse(await c.req.json());
  const data = await validateActivation({
    db: c.env.DB,
    env: c.env,
    accountId: input.account_id,
    productId: input.product_id,
    activationId: input.activation_id,
    machineToken: input.machine_token,
    fingerprint: input.fingerprint,
    releaseVersion: input.release_version,
    releasePlatform: input.release_platform,
  });
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: { valid: true, ...data } });
});

const TrialClaimSchema = z.object({
  account_id: z.string().min(1),
  product_id: z.string().min(1),
  fingerprint: z.string().trim().min(8).max(512),
  device_platform: z.string().trim().min(1).max(100).optional(),
  ...ReleaseFields,
}).strict();

clientRouter.post("/trials/claim", async (c) => {
  const input = TrialClaimSchema.parse(await c.req.json());
  await enforceTrialClaimRateLimit({
    store: c.env.KEYS_KV,
    accountId: input.account_id,
    productId: input.product_id,
    fingerprint: input.fingerprint,
    ip: c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown",
  });
  const data = await claimTrial({
    db: c.env.DB,
    accountId: input.account_id,
    productId: input.product_id,
    fingerprint: input.fingerprint,
    releaseVersion: input.release_version,
    releasePlatform: input.release_platform,
  });
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data }, 201);
});

const TrialValidateSchema = z.object({
  account_id: z.string().min(1),
  product_id: z.string().min(1),
  trial_id: z.string().min(1),
  trial_token: z.string().min(16),
  fingerprint: z.string().trim().min(8).max(512),
  ...ReleaseFields,
}).strict();

clientRouter.post("/trials/validate", async (c) => {
  const input = TrialValidateSchema.parse(await c.req.json());
  const data = await validateTrial({
    db: c.env.DB,
    accountId: input.account_id,
    productId: input.product_id,
    trialId: input.trial_id,
    trialToken: input.trial_token,
    fingerprint: input.fingerprint,
    releaseVersion: input.release_version,
    releasePlatform: input.release_platform,
  });
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data });
});

const DeactivateSchema = z.object({
  account_id: z.string().min(1),
  product_id: z.string().min(1),
  activation_id: z.string().min(1),
  machine_token: z.string().min(16),
  fingerprint: z.string().trim().min(8).max(512),
}).strict();

clientRouter.post("/deactivate", rateLimit({ limit: 30, windowSeconds: 60, keyPrefix: "client_deactivate" }), async (c) => {
  const input = DeactivateSchema.parse(await c.req.json());
  const data = await deactivateActivation({
    db: c.env.DB,
    accountId: input.account_id,
    productId: input.product_id,
    activationId: input.activation_id,
    machineToken: input.machine_token,
    fingerprint: input.fingerprint,
  });
  return c.json({ success: true, data });
});

clientRouter.get("/products/:productId/signing-keys", async (c) => {
  const productId = c.req.param("productId");
  const result = await c.env.DB.prepare(
    `SELECT k.id, k.algorithm, k.public_key, k.status, k.created_at, k.retired_at, k.revoked_at
     FROM signing_keys AS k
     JOIN products AS p
       ON p.account_id = k.account_id AND p.id = k.product_id
     WHERE k.product_id = ?1 AND k.account_id = p.account_id
     ORDER BY k.created_at DESC`
  ).bind(productId).all<{
    id: string;
    algorithm: string;
    public_key: string;
    status: string;
    created_at: string;
    retired_at: string | null;
    revoked_at: string | null;
  }>();
  return c.json({ success: true, data: { items: result.results.map((key) => ({
    id: key.id,
    algorithm: key.algorithm,
    publicKey: key.public_key,
    status: key.status,
    createdAt: key.created_at,
    retiredAt: key.retired_at,
    revokedAt: key.revoked_at,
  })) } });
});
