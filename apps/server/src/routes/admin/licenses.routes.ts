import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, like, sql } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { activations, customers, licensePlans, licenses, products } from "../../infra/db/schema";
import { requireRole } from "../../middleware/auth";
import { AppError, NotFoundError } from "../../middleware/error";
import { dispatchDelivery } from "../../infra/delivery/dispatcher";
import { issueManualLicense } from "../../services/license/issue";
import { rotateLicenseKey } from "../../services/license/key-rotation";
import { prepareLicenseAudit } from "../../services/license/audit";
import { parseFeatures, parseIsoInstant } from "../../domain/license/terms";

export const adminLicensesRouter = new Hono<AppContext>();

function requestMetadata(c: any) {
  return {
    requestId: c.get("requestId") || c.req.header("x-request-id") || undefined,
    ip: c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: c.req.header("user-agent"),
  };
}

function formatLicense(row: any) {
  const license = row.license ?? row;
  return {
    id: license.id,
    customer_id: license.customerId,
    customer_email: row.customerEmail,
    product_id: license.productId,
    product_name: row.productName,
    license_plan_id: license.planId,
    license_plan_name: row.planName,
    plan_revision: license.planRevision,
    license_model: license.licenseModel,
    renewal_mode: license.renewalMode,
    credential_mode: license.credentialMode,
    offline_grace_seconds: license.offlineGraceSeconds,
    payment_grace_seconds: license.paymentGraceSeconds,
    max_activations: license.maxActivations,
    features: parseFeatures(license.featuresJson),
    key_version: license.keyVersion,
    source: license.source,
    status: license.status,
    status_reason: license.statusReason,
    expires_at: license.expiresAt,
    updates_until: license.updatesUntil,
    suspended_at: license.suspendedAt,
    revoked_at: license.revokedAt,
    active_activations: row.activeActivations,
    is_checkout_verification: Boolean(license.isCheckoutVerification),
    created_at: license.createdAt,
    updated_at: license.updatedAt,
  };
}

function formatIssuedLicense(result: Awaited<ReturnType<typeof issueManualLicense>>, deliveryStatus: string) {
  return {
    license: {
      id: result.license.id,
      customer_id: result.license.customerId,
      product_id: result.license.productId,
      license_plan_id: result.license.licensePlanId,
      license_key: result.license.licenseKey,
      status: result.license.status,
      license_model: result.license.licenseModel,
      renewal_mode: result.license.renewalMode,
      credential_mode: result.license.credentialMode,
      expires_at: result.license.expiresAt,
      updates_until: result.license.updatesUntil,
      payment_grace_seconds: result.license.paymentGraceSeconds,
      max_activations: result.license.maxActivations,
      features: result.license.features,
      key_version: result.license.keyVersion,
      created_at: result.license.createdAt,
    },
    delivery: { id: result.delivery.id, status: deliveryStatus },
  };
}

function formatLicenseRotation(result: Awaited<ReturnType<typeof rotateLicenseKey>>, deliveryStatus: string) {
  return {
    license_key: result.licenseKey,
    license: {
      id: result.license.id,
      customer_id: result.license.customerId,
      key_version: result.license.keyVersion,
    },
    delivery: { id: result.delivery.id, status: deliveryStatus },
  };
}

function licenseSelect(db: any) {
  return db.select({
    license: licenses,
    customerEmail: customers.email,
    productName: products.name,
    planName: licensePlans.name,
    activeActivations: sql<number>`(
      SELECT COUNT(*) FROM activations a
      WHERE a.instance_id = ${licenses.instanceId}
        AND a.license_id = ${licenses.id}
        AND a.status = 'active'
    )`,
  }).from(licenses)
    .innerJoin(customers, and(eq(customers.instanceId, licenses.instanceId), eq(customers.id, licenses.customerId)))
    .innerJoin(products, and(eq(products.instanceId, licenses.instanceId), eq(products.id, licenses.productId)))
    .innerJoin(licensePlans, and(eq(licensePlans.instanceId, licenses.instanceId), eq(licensePlans.id, licenses.planId)));
}

async function requireLicense(db: any, instanceId: string, licenseId: string) {
  const row = await licenseSelect(db).where(and(
    eq(licenses.instanceId, instanceId), eq(licenses.id, licenseId),
  )).get();
  if (!row) throw new NotFoundError("License not found");
  return row;
}

adminLicensesRouter.get("/", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const queryInput = z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    product_id: z.string().min(1).optional(),
    license_plan_id: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    customer_email: z.string().optional(),
    query: z.string().optional(),
  }).strict().parse(c.req.query());
  const page = Math.max(1, Number.parseInt(queryInput.page ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(queryInput.limit ?? "20", 10) || 20));
  const conditions: any[] = [eq(licenses.instanceId, instanceId)];
  const productId = queryInput.product_id;
  const planId = queryInput.license_plan_id;
  const status = queryInput.status;
  const customerEmail = queryInput.customer_email?.trim().toLowerCase();
  if (productId) conditions.push(eq(licenses.productId, productId));
  if (planId) conditions.push(eq(licenses.planId, planId));
  if (status) conditions.push(eq(licenses.status, status as any));
  if (customerEmail) conditions.push(eq(customers.email, customerEmail));
  const search = queryInput.query?.trim();
  if (search) conditions.push(like(licenses.id, `%${search}%`));
  const where = and(...conditions);

  const total = await db.select({ count: sql<number>`count(*)` }).from(licenses)
    .innerJoin(customers, and(eq(customers.instanceId, licenses.instanceId), eq(customers.id, licenses.customerId)))
    .where(where).get();
  const items = await licenseSelect(db).where(where)
    .orderBy(desc(licenses.createdAt)).limit(limit).offset((page - 1) * limit).all();
  const totalItems = total?.count ?? 0;
  return c.json({ success: true, data: {
    items: items.map(formatLicense),
    pagination: { page, limit, total_items: totalItems, total_pages: Math.ceil(totalItems / limit) },
  } });
});

adminLicensesRouter.post("/", requireRole(["owner", "admin"]), async (c) => {
  const input = z.object({
    license_plan_id: z.string().min(1),
    customer_email: z.string().email(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
    delivery: z.object({ send_notification: z.literal(true) }).strict().default({ send_notification: true }),
  }).strict().parse(await c.req.json());
  const metadata = requestMetadata(c);
  const result = await issueManualLicense({
    db: c.env.DB,
    env: c.env,
    instanceId: c.get("instanceId")!,
    licensePlanId: input.license_plan_id,
    customerEmail: input.customer_email,
    expiresAt: input.expires_at,
    actor: { type: "user", id: c.get("userId")! },
    ...metadata,
  });
  let deliveryStatus: string = result.delivery.status;
  if (result.delivery.status === "pending") {
    const dispatched = await dispatchDelivery({
      db: c.env.DB,
      env: c.env,
      instanceId: c.get("instanceId")!,
      deliveryId: result.delivery.id,
    });
    if (dispatched.status) deliveryStatus = dispatched.status;
  }
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: formatIssuedLicense(result, deliveryStatus),
  }, 201);
});

adminLicensesRouter.get("/:licenseId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const row = await requireLicense(getTenantDB(c), c.get("instanceId")!, c.req.param("licenseId"));
  return c.json({ success: true, data: formatLicense(row) });
});

async function changeLicenseStatus(c: any, target: "suspended" | "active" | "revoked") {
  const instanceId = c.get("instanceId")!;
  const licenseId = c.req.param("licenseId");
  const input = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().parse(await c.req.json());
  const db = getTenantDB(c);
  const row = await requireLicense(db, instanceId, licenseId);
  const license = row.license;
  if (license.isCheckoutVerification) {
    throw new AppError(
      "LICENSE_CHECKOUT_VERIFICATION_ONLY",
      "A Checkout Verification License cannot be changed into a customer entitlement.",
      409,
    );
  }
  if (license.status === target) return formatLicense(row);
  if (target === "active" && license.status === "revoked") {
    throw new AppError("LICENSE_REVOKED", "A revoked License cannot be reinstated.", 409);
  }
  if (target === "suspended" && license.status !== "active") {
    throw new AppError(
      "LICENSE_STATUS_TRANSITION_INVALID",
      `A ${license.status} License cannot be suspended.`,
      409,
      { from_status: license.status, to_status: target },
    );
  }
  if (target === "active" && license.status !== "suspended") {
    throw new AppError(
      "LICENSE_STATUS_TRANSITION_INVALID",
      `A ${license.status} License cannot be reinstated.`,
      409,
      { from_status: license.status, to_status: target },
    );
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const metadata = requestMetadata(c);
  const statement = c.env.DB.prepare(
    `UPDATE licenses
     SET status = CASE WHEN status = ?1 THEN ?2 ELSE 'invalid' END,
         status_reason = ?3,
         suspended_at = CASE WHEN ?2 = 'suspended' THEN ?4 ELSE suspended_at END,
         revoked_at = CASE WHEN ?2 = 'revoked' THEN ?4 ELSE revoked_at END,
         updated_at = ?4
     WHERE instance_id = ?5 AND id = ?6`
  ).bind(license.status, target, input.reason, nowIso, instanceId, licenseId);
  const audit = prepareLicenseAudit({
    db: c.env.DB,
    instanceId,
    actor: { type: "user", id: c.get("userId")! },
    action: `license.${target === "active" ? "reinstate" : target}`,
    resourceType: "license",
    resourceId: licenseId,
    requestId: metadata.requestId,
    details: { fromStatus: license.status, toStatus: target, reason: input.reason },
    ip: metadata.ip,
    userAgent: metadata.userAgent,
    now,
  });
  await c.env.DB.batch([statement, audit]);
  return formatLicense(await requireLicense(db, instanceId, licenseId));
}

adminLicensesRouter.post("/:licenseId/suspend", requireRole(["owner", "admin"]), async (c) =>
  c.json({ success: true, data: await changeLicenseStatus(c, "suspended") }));
adminLicensesRouter.post("/:licenseId/reinstate", requireRole(["owner", "admin"]), async (c) =>
  c.json({ success: true, data: await changeLicenseStatus(c, "active") }));
adminLicensesRouter.post("/:licenseId/revoke", requireRole(["owner", "admin"]), async (c) =>
  c.json({ success: true, data: await changeLicenseStatus(c, "revoked") }));

async function rotate(c: any, reason: "recovery" | "security_reset") {
  const metadata = requestMetadata(c);
  const result = await rotateLicenseKey({
    db: c.env.DB,
    env: c.env,
    instanceId: c.get("instanceId")!,
    licenseId: c.req.param("licenseId"),
    actor: { type: "user", id: c.get("userId")! },
    reason,
    ...metadata,
  });
  let deliveryStatus: string = result.delivery.status;
  if (result.delivery.status === "pending") {
    const dispatched = await dispatchDelivery({
      db: c.env.DB,
      env: c.env,
      instanceId: c.get("instanceId")!,
      deliveryId: result.delivery.id,
    });
    if (dispatched.status) deliveryStatus = dispatched.status;
  }
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: formatLicenseRotation(result, deliveryStatus),
  });
}

adminLicensesRouter.post("/:licenseId/recover-key", requireRole(["owner", "admin"]), (c) => rotate(c, "recovery"));
adminLicensesRouter.post("/:licenseId/security-reset", requireRole(["owner", "admin"]), (c) => rotate(c, "security_reset"));

adminLicensesRouter.post("/:licenseId/extend-updates", requireRole(["owner", "admin"]), async (c) => {
  const input = z.object({
    updates_until: z.string().datetime({ offset: true }).nullable(),
    reason: z.string().trim().min(1).max(1000),
  }).strict().parse(await c.req.json());
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const licenseId = c.req.param("licenseId");
  const row = await requireLicense(db, instanceId, licenseId);
  const license = row.license;
  if (license.isCheckoutVerification) throw new AppError("LICENSE_CHECKOUT_VERIFICATION_ONLY", "A Checkout Verification License cannot be migrated.", 409);
  if (license.licenseModel !== "perpetual") {
    throw new AppError("UPDATE_ENTITLEMENT_NOT_APPLICABLE", "Only perpetual Licenses have an update entitlement window.", 409);
  }
  const next = input.updates_until ? parseIsoInstant(input.updates_until, "updates_until").toISOString() : null;
  if (license.updatesUntil === null && next !== null) {
    throw new AppError("UPDATE_ENTITLEMENT_CANNOT_SHRINK", "An unlimited update entitlement cannot be reduced.", 409);
  }
  if (license.updatesUntil && next && Date.parse(next) < Date.parse(license.updatesUntil)) {
    throw new AppError("UPDATE_ENTITLEMENT_CANNOT_SHRINK", "updatesUntil cannot move backwards.", 409);
  }
  if (license.updatesUntil === next) return c.json({ success: true, data: formatLicense(row) });
  const now = new Date();
  const metadata = requestMetadata(c);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE licenses
       SET updates_until = ?1,
           max_activations = CASE WHEN updates_until IS ?2 THEN max_activations ELSE 0 END,
           updated_at = ?3
       WHERE instance_id = ?4 AND id = ?5`
    ).bind(next, license.updatesUntil, now.toISOString(), instanceId, licenseId),
    prepareLicenseAudit({
      db: c.env.DB, instanceId, actor: { type: "user", id: c.get("userId")! },
      action: "license.extend_updates", resourceType: "license", resourceId: licenseId,
      requestId: metadata.requestId,
      details: { fromUpdatesUntil: license.updatesUntil, toUpdatesUntil: next, reason: input.reason },
      ip: metadata.ip, userAgent: metadata.userAgent, now,
    }),
  ]);
  return c.json({ success: true, data: formatLicense(await requireLicense(db, instanceId, licenseId)) });
});

adminLicensesRouter.post("/:licenseId/renew-term", requireRole(["owner", "admin"]), async (c) => {
  const input = z.object({
    expires_at: z.string().datetime({ offset: true }),
    reason: z.string().trim().min(1).max(1000),
  }).strict().parse(await c.req.json());
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const licenseId = c.req.param("licenseId");
  const row = await requireLicense(db, instanceId, licenseId);
  const license = row.license;
  if (license.licenseModel !== "subscription" || license.renewalMode !== "manual") {
    throw new AppError("LICENSE_MANUAL_RENEWAL_NOT_ALLOWED", "Only manually renewed subscription Licenses use this operation.", 409);
  }
  const next = parseIsoInstant(input.expires_at, "expires_at").toISOString();
  if (next === license.expiresAt) return c.json({ success: true, data: formatLicense(row) });
  if (!license.expiresAt || Date.parse(next) <= Date.parse(license.expiresAt) || Date.parse(next) <= Date.now()) {
    throw new AppError("LICENSE_RENEWAL_TERM_INVALID", "expiresAt must be later than the current term and current time.", 409);
  }
  const now = new Date();
  const metadata = requestMetadata(c);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE licenses
       SET expires_at = CASE WHEN expires_at = ?1 THEN ?2 ELSE created_at END,
           updated_at = ?3
       WHERE instance_id = ?4 AND id = ?5`
    ).bind(license.expiresAt, next, now.toISOString(), instanceId, licenseId),
    prepareLicenseAudit({
      db: c.env.DB, instanceId, actor: { type: "user", id: c.get("userId")! },
      action: "license.renew_term", resourceType: "license", resourceId: licenseId,
      requestId: metadata.requestId,
      details: { fromExpiresAt: license.expiresAt, toExpiresAt: next, reason: input.reason, renewalSource: "manual" },
      ip: metadata.ip, userAgent: metadata.userAgent, now,
    }),
  ]);
  return c.json({ success: true, data: formatLicense(await requireLicense(db, instanceId, licenseId)) });
});

adminLicensesRouter.get("/:licenseId/activations", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const licenseId = c.req.param("licenseId");
  await requireLicense(db, instanceId, licenseId);
  const items = await db.select({
    id: activations.id,
    licenseId: activations.licenseId,
    name: activations.name,
    platform: activations.platform,
    firstIp: activations.firstIp,
    status: activations.status,
    activatedAt: activations.activatedAt,
    lastValidatedAt: activations.lastValidatedAt,
    deactivatedAt: activations.deactivatedAt,
    revokedAt: activations.revokedAt,
    revokeReason: activations.revokeReason,
    updatedAt: activations.updatedAt,
  }).from(activations).where(and(
    eq(activations.instanceId, instanceId), eq(activations.licenseId, licenseId),
  )).orderBy(desc(activations.activatedAt)).all();
  return c.json({ success: true, data: { items: items.map((item) => ({
    id: item.id,
    license_id: item.licenseId,
    name: item.name,
    platform: item.platform,
    first_ip: item.firstIp,
    status: item.status,
    activated_at: item.activatedAt,
    last_validated_at: item.lastValidatedAt,
    deactivated_at: item.deactivatedAt,
    revoked_at: item.revokedAt,
    revoke_reason: item.revokeReason,
    updated_at: item.updatedAt,
  })) } });
});

adminLicensesRouter.post("/:licenseId/activations/:activationId/revoke", requireRole(["owner", "admin", "member"]), async (c) => {
  const input = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().parse(await c.req.json());
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const licenseId = c.req.param("licenseId");
  const activationId = c.req.param("activationId");
  const activation = await db.select().from(activations).where(and(
    eq(activations.instanceId, instanceId), eq(activations.licenseId, licenseId), eq(activations.id, activationId),
  )).get();
  if (!activation) throw new NotFoundError("Activation not found");
  if (activation.status === "active") {
    const now = new Date();
    const metadata = requestMetadata(c);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE activations
         SET status = 'revoked', revoked_at = ?1, revoke_reason = ?2, updated_at = ?1
         WHERE instance_id = ?3 AND license_id = ?4 AND id = ?5 AND status = 'active'`
      ).bind(now.toISOString(), input.reason, instanceId, licenseId, activationId),
      prepareLicenseAudit({
        db: c.env.DB, instanceId, actor: { type: "user", id: c.get("userId")! },
        action: "activation.revoke", resourceType: "activation", resourceId: activationId,
        requestId: metadata.requestId, details: { licenseId, reason: input.reason },
        ip: metadata.ip, userAgent: metadata.userAgent, now,
      }),
    ]);
  }
  const updated = await db.select().from(activations).where(and(
    eq(activations.instanceId, instanceId), eq(activations.licenseId, licenseId), eq(activations.id, activationId),
  )).get();
  return c.json({ success: true, data: { id: updated!.id, status: updated!.status, revoked_at: updated!.revokedAt, revoke_reason: updated!.revokeReason } });
});
