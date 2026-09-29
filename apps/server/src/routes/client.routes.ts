import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../types";
import { activateLicense, deactivateActivation } from "../services/license/activation";
import { validateClient } from "../services/license/client-validation";
import { claimTrial } from "../services/license/trial";
import { NotFoundError } from "../middleware/error";

export const clientRouter = new Hono<AppContext>();

const ReleaseFields = {
  release_version: z.string().trim().min(1).max(100),
  release_platform: z.enum(["macos", "windows", "linux"]),
  release_arch: z.enum(["universal", "arm64", "x86_64"]),
};
const BillingEnvironmentField = {
  billing_environment: z.enum(["sandbox", "live"]).optional().default("live"),
};

const ActivateSchema = z.object({
  product_id: z.string().min(1),
  license_key: z.string().min(16).max(200),
  machine_token: z.string().min(32).max(512),
  fingerprint: z.string().trim().min(8).max(512),
  device_platform: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  ...ReleaseFields,
  ...BillingEnvironmentField,
}).strict();

clientRouter.post("/activate", async (c) => {
  const input = ActivateSchema.parse(await c.req.json());
  const instanceId = await resolveProductInstance(c.env.DB, input.product_id);
  const data = await activateLicense({
    db: c.env.DB,
    env: c.env,
    instanceId,
    productId: input.product_id,
    licenseKey: input.license_key,
    machineToken: input.machine_token,
    fingerprint: input.fingerprint,
    devicePlatform: input.device_platform,
    name: input.name,
    releaseVersion: input.release_version,
    releasePlatform: input.release_platform,
    releaseArch: input.release_arch,
    billingEnvironment: input.billing_environment,
    firstIp: c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
  });
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: { ...data, meta: { request_id: c.get("requestId") } },
  });
});

const CredentialSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("license"),
    activation_id: z.string().min(1),
    machine_token: z.string().min(16),
  }).strict(),
  z.object({
    kind: z.literal("trial"),
    trial_id: z.string().min(1),
    trial_token: z.string().min(16),
  }).strict(),
  z.object({
    kind: z.literal("none"),
  }).strict(),
]);

const ValidateSchema = z.object({
  product_id: z.string().min(1),
  fingerprint: z.string().trim().min(8).max(512),
  ...ReleaseFields,
  ...BillingEnvironmentField,
  credential: CredentialSchema,
}).strict();

clientRouter.post("/validate", async (c) => {
  const input = ValidateSchema.parse(await c.req.json());
  const instanceId = await resolveProductInstance(c.env.DB, input.product_id);
  const credential = input.credential.kind === "license"
    ? {
      kind: "license" as const,
      activationId: input.credential.activation_id,
      machineToken: input.credential.machine_token,
    }
    : input.credential.kind === "trial"
      ? {
        kind: "trial" as const,
        trialId: input.credential.trial_id,
        trialToken: input.credential.trial_token,
      }
      : { kind: "none" as const };
  const data = await validateClient({
    db: c.env.DB,
    env: c.env,
    instanceId,
    productId: input.product_id,
    fingerprint: input.fingerprint,
    releaseVersion: input.release_version,
    releasePlatform: input.release_platform,
    releaseArch: input.release_arch,
    billingEnvironment: input.billing_environment,
    credential,
  });
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: { ...data, meta: { request_id: c.get("requestId") } },
  });
});

const TrialClaimSchema = z.object({
  product_id: z.string().min(1),
  fingerprint: z.string().trim().min(8).max(512),
  trial_token: z.string().min(32).max(512),
  device_platform: z.string().trim().min(1).max(100).optional(),
  ...ReleaseFields,
}).strict();

clientRouter.post("/trials/claim", async (c) => {
  const input = TrialClaimSchema.parse(await c.req.json());
  const instanceId = await resolveProductInstance(c.env.DB, input.product_id);
  const data = await claimTrial({
    db: c.env.DB,
    instanceId,
    productId: input.product_id,
    fingerprint: input.fingerprint,
    trialToken: input.trial_token,
  });
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: { ...data, meta: { request_id: c.get("requestId") } },
  }, 201);
});

const DeactivateSchema = z.object({
  product_id: z.string().min(1),
  activation_id: z.string().min(1),
  machine_token: z.string().min(16),
  fingerprint: z.string().trim().min(8).max(512),
}).strict();

clientRouter.post("/deactivate", async (c) => {
  const input = DeactivateSchema.parse(await c.req.json());
  const instanceId = await resolveProductInstance(c.env.DB, input.product_id);
  const data = await deactivateActivation({
    db: c.env.DB,
    instanceId,
    productId: input.product_id,
    activationId: input.activation_id,
    machineToken: input.machine_token,
    fingerprint: input.fingerprint,
  });
  return c.json({
    success: true,
    data: { ...data, meta: { request_id: c.get("requestId") } },
  });
});

clientRouter.get("/products/:productId/signing-keys", async (c) => {
  z.object({}).strict().parse(c.req.query());
  const productId = c.req.param("productId");
  const instanceId = await resolveProductInstance(c.env.DB, productId);
  const result = await c.env.DB.prepare(
    `SELECT k.id, k.algorithm, k.public_key, k.status, k.created_at, k.retired_at, k.revoked_at
     FROM signing_keys AS k
     JOIN products AS p
       ON p.instance_id = k.instance_id AND p.id = k.product_id
     WHERE k.instance_id = ?1 AND k.product_id = ?2
     ORDER BY k.created_at DESC`
  ).bind(instanceId, productId).all<{
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
    public_key: key.public_key,
    status: key.status,
    created_at: key.created_at,
    retired_at: key.retired_at,
    revoked_at: key.revoked_at,
  })) } });
});

async function resolveProductInstance(db: D1Database, productId: string): Promise<string> {
  const result = await db.prepare(
    "SELECT instance_id FROM products WHERE id = ?1 LIMIT 1",
  ).bind(productId).all<{ instance_id: string }>();
  const product = result.results[0];
  if (!product) throw new NotFoundError("Product not found");
  return product.instance_id;
}
