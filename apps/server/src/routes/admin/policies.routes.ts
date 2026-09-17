import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq, and, sql } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { policies, products, licenses } from "../../infra/db/schema";
import { requireRole } from "../../middleware/auth";
import { NotFoundError, AppError, ConflictError } from "../../middleware/error";
import { recordAuditLog } from "../../infra/audit";

export const adminPoliciesRouter = new Hono<AppContext>();

function formatPolicy(p: any) {
  const features = typeof p.features === "string" ? JSON.parse(p.features || "[]") : (p.features || []);
  const metadata = typeof p.metadata === "string" ? JSON.parse(p.metadata || "{}") : (p.metadata || {});
  return {
    id: p.id,
    accountId: p.accountId,
    productId: p.productId,
    productName: p.productName || "Unknown Product",
    name: p.name,
    duration: p.duration,
    offlineGracePeriod: p.offlineGracePeriod,
    maxMachines: p.maxMachines,
    floating: p.floating,
    strict: p.strict,
    scheme: p.scheme,
    features,
    metadata,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// GET /api/v1/admin/policies
adminPoliciesRouter.get("/", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = c.req.query("productId") || c.req.query("product_id");

  const query = db
    .select({
      id: policies.id,
      accountId: policies.accountId,
      productId: policies.productId,
      productName: products.name,
      name: policies.name,
      duration: policies.duration,
      offlineGracePeriod: policies.offlineGracePeriod,
      maxMachines: policies.maxMachines,
      floating: policies.floating,
      strict: policies.strict,
      scheme: policies.scheme,
      features: policies.features,
      metadata: policies.metadata,
      isActive: policies.isActive,
      createdAt: policies.createdAt,
      updatedAt: policies.updatedAt,
    })
    .from(policies)
    .leftJoin(products, eq(policies.productId, products.id))
    .where(
      productId
        ? and(eq(policies.accountId, accountId), eq(policies.productId, productId))
        : eq(policies.accountId, accountId)
    );

  const list = await query.all();

  return c.json({
    success: true,
    data: {
      items: list.map(formatPolicy),
    },
  });
});

// GET /api/v1/admin/policies/:id
adminPoliciesRouter.get("/:id", async (c) => {
  const policyId = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const policy = await db
    .select({
      id: policies.id,
      accountId: policies.accountId,
      productId: policies.productId,
      productName: products.name,
      name: policies.name,
      duration: policies.duration,
      offlineGracePeriod: policies.offlineGracePeriod,
      maxMachines: policies.maxMachines,
      floating: policies.floating,
      strict: policies.strict,
      scheme: policies.scheme,
      features: policies.features,
      metadata: policies.metadata,
      isActive: policies.isActive,
      createdAt: policies.createdAt,
      updatedAt: policies.updatedAt,
    })
    .from(policies)
    .leftJoin(products, eq(policies.productId, products.id))
    .where(and(eq(policies.id, policyId), eq(policies.accountId, accountId)))
    .get();

  if (!policy) {
    throw new NotFoundError("Policy not found");
  }

  return c.json({
    success: true,
    data: formatPolicy(policy),
  });
});

const CreatePolicySchema = z.object({
  productId: z.string(),
  name: z.string().min(1),
  duration: z.number().int().positive().nullable().optional(),
  offlineGracePeriod: z.number().int().nonnegative().default(2592000),
  maxMachines: z.number().int().min(1).default(1),
  floating: z.boolean().default(false),
  strict: z.boolean().default(true),
  scheme: z.enum(["ed25519", "guid"]).default("ed25519"),
  features: z.array(z.string()).default([]),
  metadata: z.record(z.any()).default({}),
});

// POST /api/v1/admin/policies
adminPoliciesRouter.post("/", requireRole(["owner", "admin"]), async (c) => {
  const body = await c.req.json();
  const input = CreatePolicySchema.parse(body);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  // Verify product belongs to tenant and is active
  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.accountId, accountId)))
    .get();

  if (!product) {
    throw new NotFoundError("Product not found");
  }

  if (!product.isActive) {
    throw new AppError("PRODUCT_INACTIVE", "Cannot create policy for an inactive product", 400);
  }

  const policyId = `pol_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();

  await db.insert(policies).values({
    id: policyId,
    accountId,
    productId: input.productId,
    name: input.name,
    duration: input.duration || null,
    offlineGracePeriod: input.offlineGracePeriod,
    maxMachines: input.maxMachines,
    floating: input.floating,
    strict: input.strict,
    scheme: input.scheme,
    features: JSON.stringify(input.features),
    metadata: JSON.stringify(input.metadata),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  await recordAuditLog({
    c,
    action: "policy.create",
    resourceType: "policy",
    resourceId: policyId,
    details: {
      productId: input.productId,
      productName: product.name,
      name: input.name,
      duration: input.duration,
      scheme: input.scheme,
      maxMachines: input.maxMachines,
    },
  });

  return c.json(
    {
      success: true,
      data: {
        id: policyId,
        accountId,
        productId: input.productId,
        productName: product.name,
        name: input.name,
        duration: input.duration || null,
        offlineGracePeriod: input.offlineGracePeriod,
        scheme: input.scheme,
        maxMachines: input.maxMachines,
        features: input.features,
        metadata: input.metadata,
        isActive: true,
      },
    },
    201
  );
});

const UpdatePolicySchema = z.object({
  name: z.string().min(1).optional(),
  duration: z.number().int().positive().nullable().optional(),
  offlineGracePeriod: z.number().int().nonnegative().optional(),
  maxMachines: z.number().int().min(1).optional(),
  floating: z.boolean().optional(),
  strict: z.boolean().optional(),
  scheme: z.enum(["ed25519", "guid"]).optional(),
  features: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
  isActive: z.boolean().optional(),
});

// PATCH /api/v1/admin/policies/:id
adminPoliciesRouter.patch("/:id", requireRole(["owner", "admin", "member"]), async (c) => {
  const policyId = c.req.param("id");
  const body = await c.req.json();
  const input = UpdatePolicySchema.parse(body);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const policy = await db
    .select()
    .from(policies)
    .where(and(eq(policies.id, policyId), eq(policies.accountId, accountId)))
    .get();

  if (!policy) {
    throw new NotFoundError("Policy not found");
  }

  const now = new Date().toISOString();
  const updateData: Record<string, any> = { updatedAt: now };

  if (input.name !== undefined) updateData.name = input.name;
  if (input.duration !== undefined) updateData.duration = input.duration;
  if (input.offlineGracePeriod !== undefined) updateData.offlineGracePeriod = input.offlineGracePeriod;
  if (input.maxMachines !== undefined) updateData.maxMachines = input.maxMachines;
  if (input.floating !== undefined) updateData.floating = input.floating;
  if (input.strict !== undefined) updateData.strict = input.strict;
  if (input.scheme !== undefined) updateData.scheme = input.scheme;
  if (input.features !== undefined) updateData.features = JSON.stringify(input.features);
  if (input.metadata !== undefined) updateData.metadata = JSON.stringify(input.metadata);
  if (input.isActive !== undefined) updateData.isActive = input.isActive;

  await db
    .update(policies)
    .set(updateData)
    .where(and(eq(policies.id, policyId), eq(policies.accountId, accountId)));

  const updated = await db
    .select({
      id: policies.id,
      accountId: policies.accountId,
      productId: policies.productId,
      productName: products.name,
      name: policies.name,
      duration: policies.duration,
      offlineGracePeriod: policies.offlineGracePeriod,
      maxMachines: policies.maxMachines,
      floating: policies.floating,
      strict: policies.strict,
      scheme: policies.scheme,
      features: policies.features,
      metadata: policies.metadata,
      isActive: policies.isActive,
      createdAt: policies.createdAt,
      updatedAt: policies.updatedAt,
    })
    .from(policies)
    .leftJoin(products, eq(policies.productId, products.id))
    .where(and(eq(policies.id, policyId), eq(policies.accountId, accountId)))
    .get();

  await recordAuditLog({
    c,
    action: "policy.update",
    resourceType: "policy",
    resourceId: policyId,
    details: {
      name: updated?.name,
      updatedFields: Object.keys(input),
    },
  });

  return c.json({
    success: true,
    data: formatPolicy(updated!),
  });
});

// DELETE /api/v1/admin/policies/:id
adminPoliciesRouter.delete("/:id", requireRole(["owner", "admin"]), async (c) => {
  const policyId = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const policy = await db
    .select()
    .from(policies)
    .where(and(eq(policies.id, policyId), eq(policies.accountId, accountId)))
    .get();

  if (!policy) {
    throw new NotFoundError("Policy not found");
  }

  // Check if any licenses use this policy
  const existingLicense = await db
    .select({ count: sql<number>`count(*)` })
    .from(licenses)
    .where(and(eq(licenses.policyId, policyId), eq(licenses.accountId, accountId)))
    .get();

  if (existingLicense && existingLicense.count > 0) {
    throw new ConflictError(
      "POLICY_IN_USE",
      `Cannot delete policy: ${existingLicense.count} licenses have been issued under this policy. Please deactivate it instead.`
    );
  }

  await db.delete(policies).where(and(eq(policies.id, policyId), eq(policies.accountId, accountId)));

  await recordAuditLog({
    c,
    action: "policy.delete",
    resourceType: "policy",
    resourceId: policyId,
    details: {
      name: policy.name,
      productId: policy.productId,
    },
  });

  return c.json({
    success: true,
    data: { message: "Policy deleted successfully" },
  });
});
