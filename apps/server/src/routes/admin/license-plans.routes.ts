import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { and, desc, eq } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { accounts, licensePlans, products, signingKeys } from "../../infra/db/schema";
import { requireRole } from "../../middleware/auth";
import { AppError, NotFoundError } from "../../middleware/error";
import { recordAuditLog } from "../../infra/audit";
import { parseFeatures, type CredentialMode, type LicenseModel } from "../../domain/license/terms";

export const adminLicensePlansRouter = new Hono<AppContext>();

const LicensePlanInputSchema = z.object({
  productId: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  licenseModel: z.enum(["perpetual", "fixed_term", "subscription"]),
  credentialMode: z.enum(["opaque", "signed"]),
  defaultTermSeconds: z.number().int().positive().nullable().optional(),
  updateWindowSeconds: z.number().int().positive().nullable().optional(),
  signedTokenTtlSeconds: z.number().int().nonnegative(),
  paymentGraceSeconds: z.number().int().nonnegative().optional(),
  maxActivations: z.number().int().min(1),
  features: z.array(z.string().trim().min(1)).default([]),
});

const UpdateLicensePlanSchema = LicensePlanInputSchema.omit({ productId: true }).partial().strict()
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

function validatePlanShape(input: {
  licenseModel: LicenseModel;
  credentialMode: CredentialMode;
  defaultTermSeconds: number | null;
  updateWindowSeconds: number | null;
  signedTokenTtlSeconds: number;
  paymentGraceSeconds: number;
}) {
  if (input.licenseModel === "fixed_term" && !input.defaultTermSeconds) {
    throw new AppError("LICENSE_PLAN_TERM_REQUIRED", "A fixed-term License Plan requires defaultTermSeconds.");
  }
  if (input.licenseModel !== "fixed_term" && input.defaultTermSeconds !== null) {
    throw new AppError("LICENSE_PLAN_TERM_FORBIDDEN", "defaultTermSeconds only applies to fixed-term plans.");
  }
  if (input.licenseModel !== "perpetual" && input.updateWindowSeconds !== null) {
    throw new AppError("LICENSE_PLAN_UPDATE_WINDOW_FORBIDDEN", "updateWindowSeconds only applies to perpetual plans.");
  }
  if (input.credentialMode === "opaque" && input.signedTokenTtlSeconds !== 0) {
    throw new AppError("LICENSE_PLAN_SIGNED_TTL_FORBIDDEN", "Opaque plans require signedTokenTtlSeconds=0.");
  }
  if (input.credentialMode === "signed" && input.signedTokenTtlSeconds <= 0) {
    throw new AppError("LICENSE_PLAN_SIGNED_TTL_REQUIRED", "Signed plans require a positive signedTokenTtlSeconds.");
  }
  if (input.licenseModel !== "subscription" && input.paymentGraceSeconds !== 0) {
    throw new AppError("LICENSE_PLAN_PAYMENT_GRACE_FORBIDDEN", "Only subscription plans may define payment grace.");
  }
}

function formatPlan(plan: any, productName?: string | null) {
  return {
    id: plan.id,
    accountId: plan.accountId,
    productId: plan.productId,
    productName: productName ?? undefined,
    name: plan.name,
    revision: plan.revision,
    licenseModel: plan.licenseModel,
    credentialMode: plan.credentialMode,
    defaultTermSeconds: plan.defaultTermSeconds,
    updateWindowSeconds: plan.updateWindowSeconds,
    signedTokenTtlSeconds: plan.signedTokenTtlSeconds,
    paymentGraceSeconds: plan.paymentGraceSeconds,
    maxActivations: plan.maxActivations,
    features: parseFeatures(plan.featuresJson),
    status: plan.status,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

async function getPlan(db: any, accountId: string, planId: string) {
  const plan = await db.select().from(licensePlans).where(and(
    eq(licensePlans.accountId, accountId), eq(licensePlans.id, planId),
  )).get();
  if (!plan) throw new NotFoundError("License Plan not found");
  return plan;
}

adminLicensePlansRouter.get("/", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = c.req.query("productId");
  const where = productId
    ? and(eq(licensePlans.accountId, accountId), eq(licensePlans.productId, productId))
    : eq(licensePlans.accountId, accountId);
  const items = await db.select({ plan: licensePlans, productName: products.name })
    .from(licensePlans)
    .innerJoin(products, and(
      eq(products.accountId, licensePlans.accountId), eq(products.id, licensePlans.productId),
    ))
    .where(where).orderBy(desc(licensePlans.createdAt)).all();
  return c.json({ success: true, data: { items: items.map(({ plan, productName }) => formatPlan(plan, productName)) } });
});

adminLicensePlansRouter.get("/:planId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  return c.json({ success: true, data: formatPlan(await getPlan(db, accountId, c.req.param("planId"))) });
});

adminLicensePlansRouter.post("/", requireRole(["owner", "admin"]), async (c) => {
  const input = LicensePlanInputSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const product = await db.select().from(products).where(and(
    eq(products.accountId, accountId), eq(products.id, input.productId),
  )).get();
  if (!product) throw new NotFoundError("Product not found");
  if (product.status !== "active") {
    throw new AppError("PRODUCT_ARCHIVED", "A License Plan cannot be created for an archived Product.", 409);
  }

  if (input.credentialMode === "signed") {
    const activeKey = await db.select({ id: signingKeys.id }).from(signingKeys).where(and(
      eq(signingKeys.accountId, accountId),
      eq(signingKeys.productId, input.productId),
      eq(signingKeys.status, "active"),
    )).get();
    if (!activeKey) {
      throw new AppError("SIGNING_KEY_NOT_CONFIGURED", "Signed License Plans require an active Product signing key.", 409);
    }
  }

  let paymentGraceSeconds = input.paymentGraceSeconds;
  if (input.licenseModel === "subscription" && paymentGraceSeconds === undefined) {
    const account = await db.select({ grace: accounts.defaultSubscriptionPaymentGraceSeconds })
      .from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) throw new NotFoundError("Account not found");
    paymentGraceSeconds = account.grace;
  }
  paymentGraceSeconds ??= 0;
  const values = {
    licenseModel: input.licenseModel,
    credentialMode: input.credentialMode,
    defaultTermSeconds: input.defaultTermSeconds ?? null,
    updateWindowSeconds: input.updateWindowSeconds ?? null,
    signedTokenTtlSeconds: input.signedTokenTtlSeconds,
    paymentGraceSeconds,
  };
  validatePlanShape(values);

  const planId = `lpl_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();
  await db.insert(licensePlans).values({
    id: planId,
    accountId,
    productId: input.productId,
    name: input.name,
    revision: 1,
    ...values,
    maxActivations: input.maxActivations,
    featuresJson: JSON.stringify(input.features),
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await recordAuditLog({
    c, action: "license_plan.create", resourceType: "license_plan", resourceId: planId,
    details: { productId: input.productId, licenseModel: input.licenseModel, credentialMode: input.credentialMode },
  });
  return c.json({ success: true, data: formatPlan(await getPlan(db, accountId, planId)) }, 201);
});

adminLicensePlansRouter.patch("/:planId", requireRole(["owner", "admin"]), async (c) => {
  const input = UpdateLicensePlanSchema.parse(await c.req.json());
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const planId = c.req.param("planId");
  const existing = await getPlan(db, accountId, planId);
  if (existing.status === "archived") {
    throw new AppError("LICENSE_PLAN_ARCHIVED", "An archived License Plan cannot be edited.", 409);
  }

  const licenseModel = input.licenseModel ?? existing.licenseModel;
  const credentialMode = input.credentialMode ?? existing.credentialMode;
  let defaultTermSeconds = input.defaultTermSeconds !== undefined
    ? input.defaultTermSeconds : existing.defaultTermSeconds;
  let updateWindowSeconds = input.updateWindowSeconds !== undefined
    ? input.updateWindowSeconds : existing.updateWindowSeconds;
  let paymentGraceSeconds = input.paymentGraceSeconds !== undefined
    ? input.paymentGraceSeconds : existing.paymentGraceSeconds;
  if (input.licenseModel && input.licenseModel !== existing.licenseModel) {
    if (licenseModel !== "fixed_term" && input.defaultTermSeconds === undefined) defaultTermSeconds = null;
    if (licenseModel !== "perpetual" && input.updateWindowSeconds === undefined) updateWindowSeconds = null;
    if (licenseModel !== "subscription" && input.paymentGraceSeconds === undefined) paymentGraceSeconds = 0;
    if (licenseModel === "subscription" && input.paymentGraceSeconds === undefined) {
      const account = await db.select({ grace: accounts.defaultSubscriptionPaymentGraceSeconds })
        .from(accounts).where(eq(accounts.id, accountId)).get();
      paymentGraceSeconds = account?.grace ?? 0;
    }
  }
  const signedTokenTtlSeconds = input.signedTokenTtlSeconds ?? existing.signedTokenTtlSeconds;
  validatePlanShape({
    licenseModel,
    credentialMode,
    defaultTermSeconds,
    updateWindowSeconds,
    signedTokenTtlSeconds,
    paymentGraceSeconds,
  });
  if (credentialMode === "signed") {
    const activeKey = await db.select({ id: signingKeys.id }).from(signingKeys).where(and(
      eq(signingKeys.accountId, accountId), eq(signingKeys.productId, existing.productId), eq(signingKeys.status, "active"),
    )).get();
    if (!activeKey) throw new AppError("SIGNING_KEY_NOT_CONFIGURED", "Signed License Plans require an active Product signing key.", 409);
  }

  await db.update(licensePlans).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    licenseModel,
    credentialMode,
    defaultTermSeconds,
    updateWindowSeconds,
    signedTokenTtlSeconds,
    paymentGraceSeconds,
    ...(input.maxActivations !== undefined ? { maxActivations: input.maxActivations } : {}),
    ...(input.features !== undefined ? { featuresJson: JSON.stringify(input.features) } : {}),
    revision: existing.revision + 1,
    updatedAt: new Date().toISOString(),
  }).where(and(eq(licensePlans.accountId, accountId), eq(licensePlans.id, planId)));
  await recordAuditLog({
    c, action: "license_plan.update", resourceType: "license_plan", resourceId: planId,
    details: { fromRevision: existing.revision, toRevision: existing.revision + 1, updatedFields: Object.keys(input) },
  });
  return c.json({
    success: true,
    data: { ...formatPlan(await getPlan(db, accountId, planId)), affectsExistingLicenses: false },
  });
});

adminLicensePlansRouter.post("/:planId/archive", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const planId = c.req.param("planId");
  const plan = await getPlan(db, accountId, planId);
  if (plan.status !== "archived") {
    await db.update(licensePlans).set({ status: "archived", updatedAt: new Date().toISOString() })
      .where(and(eq(licensePlans.accountId, accountId), eq(licensePlans.id, planId)));
    await recordAuditLog({ c, action: "license_plan.archive", resourceType: "license_plan", resourceId: planId });
  }
  return c.json({ success: true, data: { id: planId, status: "archived", affectsExistingLicenses: false } });
});
