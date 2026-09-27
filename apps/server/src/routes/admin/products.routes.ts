import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { productReleases, products, signingKeys, trialClaims } from "../../infra/db/schema";
import {
  generateEd25519KeyPair,
} from "../../infra/crypto";
import { encryptEnvelopeV1 } from "../../infra/delivery/crypto";
import { requireRole } from "../../middleware/auth";
import { ConflictError, NotFoundError } from "../../middleware/error";
import { recordAuditLog } from "../../infra/audit";
import { parseFeatures } from "../../domain/license/terms";

export const adminProductsRouter = new Hono<AppContext>();

const ExternalTrialConfigSchema = z.object({
  enabled: z.boolean(),
  duration_seconds: z.number().int().positive().nullable().optional(),
  features: z.array(z.string().min(1)).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && !value.duration_seconds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["duration_seconds"],
      message: "duration_seconds is required when trial is enabled",
    });
  }
});
const CreateProductSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(4000).nullable().optional(),
  billing_environment: z.enum(["sandbox", "live"]).nullable().optional(),
  payment_grace_seconds: z.number().int().nonnegative().default(0),
  trial: ExternalTrialConfigSchema.optional(),
}).strict().transform((value) => ({
  name: value.name,
  description: value.description,
  billingEnvironment: value.billing_environment,
  paymentGraceSeconds: value.payment_grace_seconds,
  trial: value.trial ? {
    enabled: value.trial.enabled,
    durationSeconds: value.trial.duration_seconds,
    features: value.trial.features,
  } : undefined,
}));
const UpdateProductSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  billing_environment: z.enum(["sandbox", "live"]).nullable().optional(),
  payment_grace_seconds: z.number().int().nonnegative().optional(),
  trial: ExternalTrialConfigSchema.optional(),
}).strict().transform((value) => ({
  name: value.name,
  description: value.description,
  billingEnvironment: value.billing_environment,
  paymentGraceSeconds: value.payment_grace_seconds,
  trial: value.trial ? {
    enabled: value.trial.enabled,
    durationSeconds: value.trial.duration_seconds,
    features: value.trial.features,
  } : undefined,
}));
const CreateReleaseSchema = z.object({
  version: z.string().trim().min(1).max(100),
  platform: z.enum(["macos", "windows", "linux"]),
  arch: z.enum(["universal", "arm64", "x86_64"]),
  description: z.string().trim().max(4000).nullable().optional(),
  download_url: z.string().url().nullable().optional(),
  artifact_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  released_at: z.string().datetime({ offset: true }),
}).strict().transform((value) => ({
  version: value.version,
  platform: value.platform,
  arch: value.arch,
  description: value.description,
  downloadUrl: value.download_url,
  artifactSha256: value.artifact_sha256,
  releasedAt: value.released_at,
}));
const UpdateReleaseSchema = z.object({
  description: z.string().trim().max(4000).nullable().optional(),
  download_url: z.string().url().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "at least one mutable field is required")
  .transform((value) => ({ description: value.description, downloadUrl: value.download_url }));

function formatProduct(product: any, signingKey?: any | null) {
  return {
    id: product.id,
    instance_id: product.instanceId,
    name: product.name,
    description: product.description,
    billing_environment: product.billingEnvironment,
    payment_grace_seconds: product.paymentGraceSeconds,
    status: product.status,
    trial: {
      enabled: Boolean(product.trialEnabled),
      duration_seconds: product.trialDurationSeconds,
      features: parseFeatures(product.trialFeaturesJson),
    },
    signing_key: signingKey?.id ? {
      id: signingKey.id,
      algorithm: signingKey.algorithm,
      public_key: signingKey.publicKey,
      status: signingKey.status,
    } : null,
    created_at: product.createdAt,
    updated_at: product.updatedAt,
  };
}

function formatRelease(release: any) {
  return {
    id: release.id,
    product_id: release.productId,
    version: release.version,
    platform: release.platform,
    arch: release.arch,
    description: release.description,
    download_url: release.downloadUrl,
    artifact_sha256: release.artifactSha256,
    released_at: release.releasedAt,
    created_at: release.createdAt,
    updated_at: release.updatedAt,
  };
}

async function requireProduct(db: any, instanceId: string, productId: string) {
  const product = await db.select().from(products).where(and(
    eq(products.instanceId, instanceId), eq(products.id, productId),
  )).get();
  if (!product) throw new NotFoundError("Product not found");
  return product;
}

async function requireProductWithActiveSigningKey(db: any, instanceId: string, productId: string) {
  const row = await db.select({
    product: products,
    signingKey: {
      id: signingKeys.id,
      algorithm: signingKeys.algorithm,
      publicKey: signingKeys.publicKey,
      status: signingKeys.status,
    },
  }).from(products).leftJoin(signingKeys, and(
    eq(signingKeys.instanceId, products.instanceId),
    eq(signingKeys.productId, products.id),
    eq(signingKeys.status, "active"),
  )).where(and(
    eq(products.instanceId, instanceId),
    eq(products.id, productId),
  )).get();
  if (!row) throw new NotFoundError("Product not found");
  return row;
}

adminProductsRouter.get("/", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const db = getTenantDB(c);
  const items = await db.select({
    product: products,
    signingKey: {
      id: signingKeys.id,
      algorithm: signingKeys.algorithm,
      publicKey: signingKeys.publicKey,
      status: signingKeys.status,
    },
  }).from(products).leftJoin(signingKeys, and(
    eq(signingKeys.instanceId, products.instanceId),
    eq(signingKeys.productId, products.id),
    eq(signingKeys.status, "active"),
  ))
    .where(eq(products.instanceId, c.get("instanceId")!))
    .orderBy(desc(products.createdAt)).all();
  return c.json({
    success: true,
    data: { items: items.map((item: any) => formatProduct(item.product, item.signingKey)) },
  });
});

adminProductsRouter.post("/", requireRole(["owner", "admin"]), async (c) => {
  const input = CreateProductSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const productId = `prd_${ulid().toLowerCase()}`;
  const signingKeyId = `key_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();
  const trial = input.trial ?? { enabled: false, durationSeconds: null, features: [] };
  const keyPair = await generateEd25519KeyPair();
  const privateKeyCiphertext = await encryptEnvelopeV1(
    keyPair.privateKeyPkcs8Base64,
    c.env,
    { instanceId, table: "signing_keys", rowId: signingKeyId, field: "private_key_ciphertext" },
  );

  await db.batch([
    db.insert(products).values({
      id: productId,
      instanceId,
      name: input.name,
      description: input.description ?? null,
      billingEnvironment: input.billingEnvironment ?? null,
      paymentGraceSeconds: input.paymentGraceSeconds,
      trialEnabled: trial.enabled,
      trialDurationSeconds: trial.enabled ? trial.durationSeconds! : null,
      trialFeaturesJson: JSON.stringify(trial.features),
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(signingKeys).values({
      id: signingKeyId,
      instanceId,
      productId,
      algorithm: "Ed25519",
      source: "generated",
      publicKey: keyPair.publicKeyBase64,
      privateKeyCiphertext,
      status: "active",
      createdAt: now,
      retiredAt: null,
      revokedAt: null,
    }),
  ]);

  await recordAuditLog({
    c, action: "product.create", resourceType: "product", resourceId: productId,
    details: { billingEnvironment: input.billingEnvironment ?? null },
  });
  const created = await requireProduct(db, instanceId, productId);
  return c.json({
    success: true,
    data: {
      ...formatProduct(created),
      signing_key: {
        id: signingKeyId,
        algorithm: "Ed25519",
        public_key: keyPair.publicKeyBase64,
        status: "active",
      },
    },
  }, 201);
});

adminProductsRouter.get("/:productId/releases", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const productId = c.req.param("productId");
  await requireProduct(db, instanceId, productId);
  const items = await db.select().from(productReleases).where(and(
    eq(productReleases.instanceId, instanceId), eq(productReleases.productId, productId),
  )).orderBy(desc(productReleases.releasedAt)).all();
  return c.json({ success: true, data: { items: items.map(formatRelease) } });
});

adminProductsRouter.post("/:productId/releases", requireRole(["owner", "admin"]), async (c) => {
  const input = CreateReleaseSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const productId = c.req.param("productId");
  await requireProduct(db, instanceId, productId);
  const releaseId = `rel_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();
  try {
    await db.insert(productReleases).values({
      id: releaseId,
      instanceId,
      productId,
      version: input.version,
      platform: input.platform,
      arch: input.arch,
      description: input.description ?? null,
      downloadUrl: input.downloadUrl ?? null,
      artifactSha256: input.artifactSha256,
      releasedAt: new Date(input.releasedAt).toISOString(),
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (String(error).includes("product_releases.product_id, product_releases.version, product_releases.platform, product_releases.arch")) {
      throw new ConflictError("PRODUCT_RELEASE_EXISTS", "This product version, platform, and architecture already exist.");
    }
    throw error;
  }
  await recordAuditLog({
    c, action: "product_release.create", resourceType: "product_release", resourceId: releaseId,
    details: {
      productId,
      version: input.version,
      platform: input.platform,
      arch: input.arch,
      releasedAt: input.releasedAt,
    },
  });
  const created = await db.select().from(productReleases).where(and(
    eq(productReleases.instanceId, instanceId), eq(productReleases.id, releaseId),
  )).get();
  return c.json({ success: true, data: formatRelease(created) }, 201);
});

adminProductsRouter.get("/:productId/releases/:releaseId", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const release = await db.select().from(productReleases).where(and(
    eq(productReleases.instanceId, c.get("instanceId")!),
    eq(productReleases.productId, c.req.param("productId")),
    eq(productReleases.id, c.req.param("releaseId")),
  )).get();
  if (!release) throw new NotFoundError("Product Release not found");
  return c.json({ success: true, data: formatRelease(release) });
});

adminProductsRouter.patch("/:productId/releases/:releaseId", requireRole(["owner", "admin"]), async (c) => {
  const input = UpdateReleaseSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const productId = c.req.param("productId");
  const releaseId = c.req.param("releaseId");
  const existing = await db.select().from(productReleases).where(and(
    eq(productReleases.instanceId, instanceId), eq(productReleases.productId, productId), eq(productReleases.id, releaseId),
  )).get();
  if (!existing) throw new NotFoundError("Product Release not found");
  await db.update(productReleases).set({
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl } : {}),
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(productReleases.instanceId, instanceId), eq(productReleases.productId, productId), eq(productReleases.id, releaseId),
  ));
  await recordAuditLog({
    c, action: "product_release.update", resourceType: "product_release", resourceId: releaseId,
    details: { productId, updatedFields: Object.keys(input) },
  });
  const updated = await db.select().from(productReleases).where(and(
    eq(productReleases.instanceId, instanceId), eq(productReleases.id, releaseId),
  )).get();
  return c.json({ success: true, data: formatRelease(updated) });
});

adminProductsRouter.get("/:productId/trials", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const productId = c.req.param("productId");
  await requireProduct(db, instanceId, productId);
  const items = await db.select({
    id: trialClaims.id,
    productId: trialClaims.productId,
    claimedAt: trialClaims.claimedAt,
    expiresAt: trialClaims.expiresAt,
    lastValidatedAt: trialClaims.lastValidatedAt,
    revokedAt: trialClaims.revokedAt,
    revokeReason: trialClaims.revokeReason,
    featuresJson: trialClaims.featuresJson,
  }).from(trialClaims).where(and(
    eq(trialClaims.instanceId, instanceId), eq(trialClaims.productId, productId),
  )).orderBy(desc(trialClaims.claimedAt)).all();
  return c.json({ success: true, data: { items: items.map((item) => ({
    id: item.id,
    product_id: item.productId,
    claimed_at: item.claimedAt,
    expires_at: item.expiresAt,
    last_validated_at: item.lastValidatedAt,
    revoked_at: item.revokedAt,
    revoke_reason: item.revokeReason,
    features: parseFeatures(item.featuresJson),
  })) } });
});

adminProductsRouter.get("/:productId/trials/:trialId", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const trial = await db.select().from(trialClaims).where(and(
    eq(trialClaims.instanceId, c.get("instanceId")!),
    eq(trialClaims.productId, c.req.param("productId")),
    eq(trialClaims.id, c.req.param("trialId")),
  )).get();
  if (!trial) throw new NotFoundError("Trial Claim not found");
  return c.json({ success: true, data: {
    id: trial.id,
    instance_id: trial.instanceId,
    product_id: trial.productId,
    claimed_at: trial.claimedAt,
    expires_at: trial.expiresAt,
    last_validated_at: trial.lastValidatedAt,
    revoked_at: trial.revokedAt,
    revoke_reason: trial.revokeReason,
    updated_at: trial.updatedAt,
    features: parseFeatures(trial.featuresJson),
  } });
});

adminProductsRouter.post("/:productId/trials/:trialId/revoke", requireRole(["owner", "admin"]), async (c) => {
  const input = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().parse(await c.req.json());
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const productId = c.req.param("productId");
  const trialId = c.req.param("trialId");
  const trial = await db.select().from(trialClaims).where(and(
    eq(trialClaims.instanceId, instanceId), eq(trialClaims.productId, productId), eq(trialClaims.id, trialId),
  )).get();
  if (!trial) throw new NotFoundError("Trial Claim not found");
  if (!trial.revokedAt) {
    const now = new Date().toISOString();
    await db.update(trialClaims).set({ revokedAt: now, revokeReason: input.reason, updatedAt: now }).where(and(
      eq(trialClaims.instanceId, instanceId), eq(trialClaims.productId, productId), eq(trialClaims.id, trialId),
      sql`${trialClaims.revokedAt} IS NULL`,
    ));
    await recordAuditLog({
      c, action: "trial_claim.revoke", resourceType: "trial_claim", resourceId: trialId,
      details: { productId, reason: input.reason },
    });
  }
  const updated = await db.select().from(trialClaims).where(and(
    eq(trialClaims.instanceId, instanceId), eq(trialClaims.productId, productId), eq(trialClaims.id, trialId),
  )).get();
  return c.json({ success: true, data: {
    id: updated!.id, revoked_at: updated!.revokedAt, revoke_reason: updated!.revokeReason,
  } });
});

adminProductsRouter.get("/:productId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const row = await requireProductWithActiveSigningKey(
    getTenantDB(c), c.get("instanceId")!, c.req.param("productId"),
  );
  return c.json({ success: true, data: formatProduct(row.product, row.signingKey) });
});

adminProductsRouter.patch("/:productId", requireRole(["owner", "admin"]), async (c) => {
  const input = UpdateProductSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const productId = c.req.param("productId");
  const existing = await requireProduct(db, instanceId, productId);

  if (input.billingEnvironment !== undefined && input.billingEnvironment !== existing.billingEnvironment) {
    const lock = await db.select({
      activeOfferCount: sql<number>`(
        SELECT COUNT(*) FROM billing_offers
        WHERE instance_id = ${instanceId} AND product_id = ${productId} AND status = 'active'
      )`,
      paymentLicenseCount: sql<number>`(
        SELECT COUNT(*) FROM licenses
        WHERE instance_id = ${instanceId} AND product_id = ${productId}
          AND source = 'payment' AND is_checkout_verification = 0
      )`,
    }).from(products).where(and(eq(products.instanceId, instanceId), eq(products.id, productId))).get();
    if ((lock?.activeOfferCount ?? 0) > 0 || (lock?.paymentLicenseCount ?? 0) > 0) {
      throw new ConflictError(
        "PRODUCT_BILLING_ENVIRONMENT_LOCKED",
        "The Product billing environment is locked by active Offers or payment Licenses.",
      );
    }
  }

  const trial = input.trial;
  await db.update(products).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.billingEnvironment !== undefined ? { billingEnvironment: input.billingEnvironment } : {}),
    ...(input.paymentGraceSeconds !== undefined ? { paymentGraceSeconds: input.paymentGraceSeconds } : {}),
    ...(trial !== undefined ? {
      trialEnabled: trial.enabled,
      trialDurationSeconds: trial.enabled ? trial.durationSeconds! : null,
      trialFeaturesJson: JSON.stringify(trial.features),
    } : {}),
    updatedAt: new Date().toISOString(),
  }).where(and(eq(products.instanceId, instanceId), eq(products.id, productId)));
  await recordAuditLog({
    c, action: "product.update", resourceType: "product", resourceId: productId,
    details: { updatedFields: Object.keys(input) },
  });
  const updated = await requireProductWithActiveSigningKey(db, instanceId, productId);
  return c.json({ success: true, data: formatProduct(updated.product, updated.signingKey) });
});

adminProductsRouter.post("/:productId/archive", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const productId = c.req.param("productId");
  await requireProduct(db, instanceId, productId);
  await db.update(products).set({ status: "archived", updatedAt: new Date().toISOString() }).where(and(
    eq(products.instanceId, instanceId), eq(products.id, productId),
  ));
  await recordAuditLog({ c, action: "product.archive", resourceType: "product", resourceId: productId });
  return c.json({ success: true, data: { id: productId, status: "archived" } });
});
