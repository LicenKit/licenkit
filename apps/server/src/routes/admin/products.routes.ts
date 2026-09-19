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

const SlugSchema = z.string().min(1).max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lower-case and URL-safe");
const TrialConfigSchema = z.object({
  enabled: z.boolean(),
  durationSeconds: z.number().int().positive().nullable().optional(),
  features: z.array(z.string().min(1)).default([]),
}).superRefine((value, ctx) => {
  if (value.enabled && !value.durationSeconds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["durationSeconds"],
      message: "durationSeconds is required when trial is enabled",
    });
  }
});
const CreateProductSchema = z.object({
  slug: SlugSchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(4000).nullable().optional(),
  billingEnvironment: z.enum(["sandbox", "live"]).nullable().optional(),
  trial: TrialConfigSchema.optional(),
});
const UpdateProductSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  billingEnvironment: z.enum(["sandbox", "live"]).nullable().optional(),
  trial: TrialConfigSchema.optional(),
}).strict();
const CreateReleaseSchema = z.object({
  version: z.string().trim().min(1).max(100),
  platform: z.string().trim().min(1).max(100),
  description: z.string().trim().max(4000).nullable().optional(),
  downloadUrl: z.string().url().nullable().optional(),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  releasedAt: z.string().datetime({ offset: true }),
});
const UpdateReleaseSchema = z.object({
  description: z.string().trim().max(4000).nullable().optional(),
  downloadUrl: z.string().url().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "at least one mutable field is required");

function formatProduct(product: any) {
  return {
    id: product.id,
    accountId: product.accountId,
    slug: product.slug,
    name: product.name,
    description: product.description,
    billingEnvironment: product.billingEnvironment,
    status: product.status,
    trial: {
      enabled: Boolean(product.trialEnabled),
      durationSeconds: product.trialDurationSeconds,
      features: parseFeatures(product.trialFeaturesJson),
    },
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

function formatRelease(release: any) {
  return {
    id: release.id,
    productId: release.productId,
    version: release.version,
    platform: release.platform,
    description: release.description,
    downloadUrl: release.downloadUrl,
    artifactSha256: release.artifactSha256,
    releasedAt: release.releasedAt,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
  };
}

async function requireProduct(db: any, accountId: string, productId: string) {
  const product = await db.select().from(products).where(and(
    eq(products.accountId, accountId), eq(products.id, productId),
  )).get();
  if (!product) throw new NotFoundError("Product not found");
  return product;
}

adminProductsRouter.get("/", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const db = getTenantDB(c);
  const items = await db.select().from(products)
    .where(eq(products.accountId, c.get("accountId")!))
    .orderBy(desc(products.createdAt)).all();
  return c.json({ success: true, data: { items: items.map(formatProduct) } });
});

adminProductsRouter.post("/", requireRole(["owner", "admin"]), async (c) => {
  const input = CreateProductSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = `prd_${ulid().toLowerCase()}`;
  const signingKeyId = `key_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();
  const trial = input.trial ?? { enabled: false, durationSeconds: null, features: [] };
  const keyPair = await generateEd25519KeyPair();
  const privateKeyCiphertext = await encryptEnvelopeV1(
    keyPair.privateKeyPkcs8Base64,
    c.env,
    { accountId, table: "signing_keys", rowId: signingKeyId, field: "private_key_ciphertext" },
  );

  try {
    await db.batch([
      db.insert(products).values({
        id: productId,
        accountId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        billingEnvironment: input.billingEnvironment ?? null,
        trialEnabled: trial.enabled,
        trialDurationSeconds: trial.enabled ? trial.durationSeconds! : null,
        trialFeaturesJson: JSON.stringify(trial.features),
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(signingKeys).values({
        id: signingKeyId,
        accountId,
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
  } catch (error) {
    if (String(error).includes("products.account_id, products.slug")) {
      throw new ConflictError("PRODUCT_SLUG_EXISTS", "The product slug is already in use.");
    }
    throw error;
  }

  await recordAuditLog({
    c, action: "product.create", resourceType: "product", resourceId: productId,
    details: { slug: input.slug, billingEnvironment: input.billingEnvironment ?? null },
  });
  const created = await requireProduct(db, accountId, productId);
  return c.json({
    success: true,
    data: {
      ...formatProduct(created),
      signingKey: { id: signingKeyId, publicKey: keyPair.publicKeyBase64, status: "active" },
    },
  }, 201);
});

adminProductsRouter.get("/:productId/releases", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = c.req.param("productId");
  await requireProduct(db, accountId, productId);
  const items = await db.select().from(productReleases).where(and(
    eq(productReleases.accountId, accountId), eq(productReleases.productId, productId),
  )).orderBy(desc(productReleases.releasedAt)).all();
  return c.json({ success: true, data: { items: items.map(formatRelease) } });
});

adminProductsRouter.post("/:productId/releases", requireRole(["owner", "admin"]), async (c) => {
  const input = CreateReleaseSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = c.req.param("productId");
  await requireProduct(db, accountId, productId);
  const releaseId = `rel_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();
  try {
    await db.insert(productReleases).values({
      id: releaseId,
      accountId,
      productId,
      version: input.version,
      platform: input.platform,
      description: input.description ?? null,
      downloadUrl: input.downloadUrl ?? null,
      artifactSha256: input.artifactSha256,
      releasedAt: new Date(input.releasedAt).toISOString(),
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (String(error).includes("product_releases.account_id, product_releases.product_id, product_releases.version, product_releases.platform")) {
      throw new ConflictError("PRODUCT_RELEASE_EXISTS", "This product version and platform already exist.");
    }
    throw error;
  }
  await recordAuditLog({
    c, action: "product_release.create", resourceType: "product_release", resourceId: releaseId,
    details: { productId, version: input.version, platform: input.platform, releasedAt: input.releasedAt },
  });
  const created = await db.select().from(productReleases).where(and(
    eq(productReleases.accountId, accountId), eq(productReleases.id, releaseId),
  )).get();
  return c.json({ success: true, data: formatRelease(created) }, 201);
});

adminProductsRouter.get("/:productId/releases/:releaseId", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const release = await db.select().from(productReleases).where(and(
    eq(productReleases.accountId, c.get("accountId")!),
    eq(productReleases.productId, c.req.param("productId")),
    eq(productReleases.id, c.req.param("releaseId")),
  )).get();
  if (!release) throw new NotFoundError("Product Release not found");
  return c.json({ success: true, data: formatRelease(release) });
});

adminProductsRouter.patch("/:productId/releases/:releaseId", requireRole(["owner", "admin"]), async (c) => {
  const input = UpdateReleaseSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = c.req.param("productId");
  const releaseId = c.req.param("releaseId");
  const existing = await db.select().from(productReleases).where(and(
    eq(productReleases.accountId, accountId), eq(productReleases.productId, productId), eq(productReleases.id, releaseId),
  )).get();
  if (!existing) throw new NotFoundError("Product Release not found");
  await db.update(productReleases).set({
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl } : {}),
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(productReleases.accountId, accountId), eq(productReleases.productId, productId), eq(productReleases.id, releaseId),
  ));
  await recordAuditLog({
    c, action: "product_release.update", resourceType: "product_release", resourceId: releaseId,
    details: { productId, updatedFields: Object.keys(input) },
  });
  const updated = await db.select().from(productReleases).where(and(
    eq(productReleases.accountId, accountId), eq(productReleases.id, releaseId),
  )).get();
  return c.json({ success: true, data: formatRelease(updated) });
});

adminProductsRouter.get("/:productId/trials", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = c.req.param("productId");
  await requireProduct(db, accountId, productId);
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
    eq(trialClaims.accountId, accountId), eq(trialClaims.productId, productId),
  )).orderBy(desc(trialClaims.claimedAt)).all();
  return c.json({ success: true, data: { items: items.map(({ featuresJson, ...item }) => ({
    ...item, features: parseFeatures(featuresJson),
  })) } });
});

adminProductsRouter.get("/:productId/trials/:trialId", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const trial = await db.select().from(trialClaims).where(and(
    eq(trialClaims.accountId, c.get("accountId")!),
    eq(trialClaims.productId, c.req.param("productId")),
    eq(trialClaims.id, c.req.param("trialId")),
  )).get();
  if (!trial) throw new NotFoundError("Trial Claim not found");
  const { trialTokenHash: _token, fingerprintHash: _fingerprint, featuresJson, ...safe } = trial;
  return c.json({ success: true, data: { ...safe, features: parseFeatures(featuresJson) } });
});

adminProductsRouter.post("/:productId/trials/:trialId/revoke", requireRole(["owner", "admin"]), async (c) => {
  const input = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(await c.req.json());
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = c.req.param("productId");
  const trialId = c.req.param("trialId");
  const trial = await db.select().from(trialClaims).where(and(
    eq(trialClaims.accountId, accountId), eq(trialClaims.productId, productId), eq(trialClaims.id, trialId),
  )).get();
  if (!trial) throw new NotFoundError("Trial Claim not found");
  if (!trial.revokedAt) {
    const now = new Date().toISOString();
    await db.update(trialClaims).set({ revokedAt: now, revokeReason: input.reason, updatedAt: now }).where(and(
      eq(trialClaims.accountId, accountId), eq(trialClaims.productId, productId), eq(trialClaims.id, trialId),
      sql`${trialClaims.revokedAt} IS NULL`,
    ));
    await recordAuditLog({
      c, action: "trial_claim.revoke", resourceType: "trial_claim", resourceId: trialId,
      details: { productId, reason: input.reason },
    });
  }
  const updated = await db.select().from(trialClaims).where(and(
    eq(trialClaims.accountId, accountId), eq(trialClaims.productId, productId), eq(trialClaims.id, trialId),
  )).get();
  return c.json({ success: true, data: {
    id: updated!.id, revokedAt: updated!.revokedAt, revokeReason: updated!.revokeReason,
  } });
});

adminProductsRouter.get("/:productId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const product = await requireProduct(getTenantDB(c), c.get("accountId")!, c.req.param("productId"));
  return c.json({ success: true, data: formatProduct(product) });
});

adminProductsRouter.patch("/:productId", requireRole(["owner", "admin"]), async (c) => {
  const input = UpdateProductSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = c.req.param("productId");
  const existing = await requireProduct(db, accountId, productId);

  if (input.billingEnvironment !== undefined && input.billingEnvironment !== existing.billingEnvironment) {
    const lock = await db.select({
      activeOfferCount: sql<number>`(
        SELECT COUNT(*) FROM billing_offers
        WHERE account_id = ${accountId} AND product_id = ${productId} AND status = 'active'
      )`,
      paymentLicenseCount: sql<number>`(
        SELECT COUNT(*) FROM licenses
        WHERE account_id = ${accountId} AND product_id = ${productId}
          AND source = 'payment' AND is_checkout_verification = 0
      )`,
    }).from(products).where(and(eq(products.accountId, accountId), eq(products.id, productId))).get();
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
    ...(trial !== undefined ? {
      trialEnabled: trial.enabled,
      trialDurationSeconds: trial.enabled ? trial.durationSeconds! : null,
      trialFeaturesJson: JSON.stringify(trial.features),
    } : {}),
    updatedAt: new Date().toISOString(),
  }).where(and(eq(products.accountId, accountId), eq(products.id, productId)));
  await recordAuditLog({
    c, action: "product.update", resourceType: "product", resourceId: productId,
    details: { updatedFields: Object.keys(input) },
  });
  return c.json({ success: true, data: formatProduct(await requireProduct(db, accountId, productId)) });
});

adminProductsRouter.post("/:productId/archive", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = c.req.param("productId");
  await requireProduct(db, accountId, productId);
  await db.update(products).set({ status: "archived", updatedAt: new Date().toISOString() }).where(and(
    eq(products.accountId, accountId), eq(products.id, productId),
  ));
  await recordAuditLog({ c, action: "product.archive", resourceType: "product", resourceId: productId });
  return c.json({ success: true, data: { id: productId, status: "archived" } });
});
