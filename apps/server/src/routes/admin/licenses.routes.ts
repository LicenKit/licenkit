import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq, and, desc, sql, like, or } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { licenses, policies, machines, products } from "../../infra/db/schema";
import { generateLicenseKey } from "../../infra/crypto";
import { broadcastOutboundEvent } from "../../infra/events/broadcast";
import { requireRole } from "../../middleware/auth";
import { NotFoundError, AppError, ConflictError } from "../../middleware/error";

export const adminLicensesRouter = new Hono<AppContext>();

function formatLicense(l: any) {
  const metadata = typeof l.metadata === "string" ? JSON.parse(l.metadata || "{}") : (l.metadata || {});
  return {
    id: l.id,
    accountId: l.accountId,
    productId: l.productId,
    productName: l.productName || "Unknown Product",
    policyId: l.policyId,
    policyName: l.policyName || "Unknown Policy",
    maxMachines: l.maxMachines || 1,
    machinesCount: l.machinesCount || 0,
    scheme: l.scheme,
    key: l.key,
    customerEmail: l.customerEmail,
    status: l.status,
    metadata,
    expiresAt: l.expiresAt,
    suspendedAt: l.suspendedAt,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

// GET /api/v1/admin/licenses
adminLicensesRouter.get("/", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const offset = (page - 1) * limit;

  const productId = c.req.query("productId") || c.req.query("product_id");
  const policyId = c.req.query("policyId") || c.req.query("policy_id");
  const status = c.req.query("status");
  const customerEmail = c.req.query("customerEmail") || c.req.query("customer_email");
  const search = c.req.query("query");

  // Build filter conditions
  const conditions = [eq(licenses.accountId, accountId)];
  if (productId) conditions.push(eq(licenses.productId, productId));
  if (policyId) conditions.push(eq(licenses.policyId, policyId));
  if (status && status !== "all") conditions.push(eq(licenses.status, status));
  if (customerEmail) conditions.push(eq(licenses.customerEmail, customerEmail.toLowerCase().trim()));
  if (search) {
    const term = `%${search.trim()}%`;
    conditions.push(or(like(licenses.key, term), like(licenses.customerEmail, term))!);
  }

  const combinedCondition = and(...conditions);

  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(licenses)
    .where(combinedCondition)
    .get();

  const totalItems = totalResult?.count || 0;
  const totalPages = Math.ceil(totalItems / limit);

  const list = await db
    .select({
      id: licenses.id,
      accountId: licenses.accountId,
      productId: licenses.productId,
      productName: products.name,
      policyId: licenses.policyId,
      policyName: policies.name,
      maxMachines: policies.maxMachines,
      scheme: policies.scheme,
      key: licenses.key,
      customerEmail: licenses.customerEmail,
      status: licenses.status,
      metadata: licenses.metadata,
      expiresAt: licenses.expiresAt,
      suspendedAt: licenses.suspendedAt,
      createdAt: licenses.createdAt,
      updatedAt: licenses.updatedAt,
      machinesCount: sql<number>`(SELECT count(*) FROM machines WHERE machines.license_id = ${licenses.id})`,
    })
    .from(licenses)
    .leftJoin(products, eq(licenses.productId, products.id))
    .leftJoin(policies, eq(licenses.policyId, policies.id))
    .where(combinedCondition)
    .orderBy(desc(licenses.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  return c.json({
    success: true,
    data: {
      items: list.map(formatLicense),
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
        hasNext: page < totalPages,
      },
    },
  });
});

const IssueLicenseSchema = z.object({
  productId: z.string(),
  policyId: z.string(),
  customerEmail: z.string().email(),
  key: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
  metadata: z.record(z.any()).default({}),
});

// POST /api/v1/admin/licenses
adminLicensesRouter.post("/", requireRole(["owner", "admin", "member"]), async (c) => {
  const body = await c.req.json();
  const input = IssueLicenseSchema.parse(body);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  // 1. Verify product belongs to tenant
  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.accountId, accountId)))
    .get();

  if (!product) {
    throw new NotFoundError("Product not found");
  }

  // 2. Verify policy belongs to tenant AND belongs to the specified product
  const policy = await db
    .select()
    .from(policies)
    .where(and(eq(policies.id, input.policyId), eq(policies.accountId, accountId)))
    .get();

  if (!policy) {
    throw new NotFoundError("Policy not found");
  }

  if (policy.productId !== input.productId) {
    throw new AppError(
      "INVALID_POLICY_PRODUCT",
      `Selected policy "${policy.name}" does not belong to the selected product "${product.name}".`,
      400
    );
  }

  const licenseId = `lic_${ulid().toLowerCase()}`;
  const key = input.key ? input.key.trim().toUpperCase() : generateLicenseKey();
  const now = new Date();

  let expiresAt: string | null = null;
  if (input.expiresAt !== undefined) {
    expiresAt = input.expiresAt;
  } else if (policy.duration) {
    expiresAt = new Date(now.getTime() + policy.duration * 1000).toISOString();
  }

  try {
    await db.insert(licenses).values({
      id: licenseId,
      accountId,
      productId: input.productId,
      policyId: input.policyId,
      key,
      customerEmail: input.customerEmail.toLowerCase().trim(),
      status: "active",
      metadata: JSON.stringify(input.metadata),
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  } catch (err: any) {
    if (err?.message?.includes("UNIQUE") || err?.message?.includes("constraint")) {
      throw new ConflictError(
        "KEY_EXISTS",
        `License key "${key}" already exists. Please choose another key or leave blank to auto-generate.`
      );
    }
    throw err;
  }

  await broadcastOutboundEvent(
    c.env,
    db,
    accountId,
    "license.created",
    {
      id: licenseId,
      key,
      customerEmail: input.customerEmail.toLowerCase().trim(),
      productId: input.productId,
      policyId: input.policyId,
      status: "active",
      expiresAt,
    },
    input.productId
  );

  return c.json(
    {
      success: true,
      data: {
        id: licenseId,
        key,
        customerEmail: input.customerEmail.toLowerCase().trim(),
        expiresAt,
        status: "active",
        productName: product.name,
        policyName: policy.name,
      },
    },
    201
  );
});

// GET /api/v1/admin/licenses/:id
adminLicensesRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const license = await db
    .select({
      id: licenses.id,
      accountId: licenses.accountId,
      productId: licenses.productId,
      productName: products.name,
      policyId: licenses.policyId,
      policyName: policies.name,
      maxMachines: policies.maxMachines,
      scheme: policies.scheme,
      key: licenses.key,
      customerEmail: licenses.customerEmail,
      status: licenses.status,
      metadata: licenses.metadata,
      expiresAt: licenses.expiresAt,
      suspendedAt: licenses.suspendedAt,
      createdAt: licenses.createdAt,
      updatedAt: licenses.updatedAt,
    })
    .from(licenses)
    .leftJoin(products, eq(licenses.productId, products.id))
    .leftJoin(policies, eq(licenses.policyId, policies.id))
    .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId)))
    .get();

  if (!license) {
    throw new NotFoundError("License not found");
  }

  const boundMachines = await db
    .select()
    .from(machines)
    .where(eq(machines.licenseId, license.id))
    .all();

  return c.json({
    success: true,
    data: {
      ...formatLicense({ ...license, machinesCount: boundMachines.length }),
      machines: boundMachines.map((m) => ({
        id: m.id,
        licenseId: m.licenseId,
        fingerprint: m.fingerprint,
        name: m.name,
        platform: m.platform,
        ip: m.ip,
        lastHeartbeatAt: m.lastHeartbeatAt,
        createdAt: m.createdAt,
      })),
    },
  });
});

const UpdateLicenseSchema = z.object({
  status: z.enum(["active", "suspended", "revoked"]).optional(),
  expiresAt: z.string().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

// PATCH /api/v1/admin/licenses/:id
adminLicensesRouter.patch("/:id", requireRole(["owner", "admin", "member"]), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const input = UpdateLicenseSchema.parse(body);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const now = new Date().toISOString();

  const license = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId)))
    .get();

  if (!license) {
    throw new NotFoundError("License not found");
  }

  const updateData: Record<string, any> = { updatedAt: now };

  if (input.status !== undefined) {
    updateData.status = input.status;
    if (input.status === "suspended") {
      updateData.suspendedAt = now;
    } else if (input.status === "active") {
      updateData.suspendedAt = null;
    } else if (input.status === "revoked") {
      // If revoked, cascade delete machines
      await db.delete(machines).where(eq(machines.licenseId, id));
    }
  }

  if (input.expiresAt !== undefined) {
    updateData.expiresAt = input.expiresAt;
  }

  if (input.metadata !== undefined) {
    updateData.metadata = JSON.stringify(input.metadata);
  }

  await db
    .update(licenses)
    .set(updateData)
    .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId)));

  const eventType =
    input.status === "revoked"
      ? "license.revoked"
      : input.status === "suspended"
      ? "license.suspended"
      : "license.updated";

  await broadcastOutboundEvent(
    c.env,
    db,
    accountId,
    eventType,
    {
      id: license.id,
      key: license.key,
      productId: license.productId,
      status: input.status || license.status,
      expiresAt: input.expiresAt !== undefined ? input.expiresAt : license.expiresAt,
    },
    license.productId
  );

  return c.json({
    success: true,
    data: { message: "License updated successfully" },
  });
});

// POST /api/v1/admin/licenses/:id/rotate-key
adminLicensesRouter.post("/:id/rotate-key", requireRole(["owner", "admin", "member"]), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const customKey = body?.key ? String(body.key).trim().toUpperCase() : null;

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const now = new Date().toISOString();

  const license = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId)))
    .get();

  if (!license) {
    throw new NotFoundError("License not found");
  }

  const newKey = customKey || generateLicenseKey();

  // Atomically update key and clear all machine seat bindings
  await db.batch([
    db
      .update(licenses)
      .set({ key: newKey, updatedAt: now })
      .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId))),
    db.delete(machines).where(eq(machines.licenseId, id)),
  ]);

  return c.json({
    success: true,
    data: {
      newKey,
      message: "License key rotated successfully and all previous devices unregistered.",
    },
  });
});

// POST /api/v1/admin/licenses/:id/revoke
adminLicensesRouter.post("/:id/revoke", requireRole(["owner", "admin", "member"]), async (c) => {
  const id = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const now = new Date().toISOString();

  const license = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId)))
    .get();

  if (!license) {
    throw new NotFoundError("License not found");
  }

  await db.batch([
    db
      .update(licenses)
      .set({ status: "revoked", updatedAt: now })
      .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId))),
    db.delete(machines).where(eq(machines.licenseId, id)),
  ]);

  await broadcastOutboundEvent(
    c.env,
    db,
    accountId,
    "license.revoked",
    {
      id: license.id,
      key: license.key,
      productId: license.productId,
      status: "revoked",
    },
    license.productId
  );

  return c.json({
    success: true,
    data: { message: "License revoked and all machine seats cleared." },
  });
});

// POST /api/v1/admin/licenses/:id/suspend
adminLicensesRouter.post("/:id/suspend", requireRole(["owner", "admin", "member"]), async (c) => {
  const id = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const now = new Date().toISOString();

  const license = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId)))
    .get();

  if (!license) {
    throw new NotFoundError("License not found");
  }

  await db
    .update(licenses)
    .set({ status: "suspended", suspendedAt: now, updatedAt: now })
    .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId)));

  await broadcastOutboundEvent(
    c.env,
    db,
    accountId,
    "license.suspended",
    {
      id: license.id,
      key: license.key,
      productId: license.productId,
      status: "suspended",
    },
    license.productId
  );

  return c.json({
    success: true,
    data: { message: "License suspended" },
  });
});

// POST /api/v1/admin/licenses/:id/reinstate
adminLicensesRouter.post("/:id/reinstate", requireRole(["owner", "admin", "member"]), async (c) => {
  const id = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const now = new Date().toISOString();

  const license = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId)))
    .get();

  if (!license) {
    throw new NotFoundError("License not found");
  }

  await db
    .update(licenses)
    .set({ status: "active", suspendedAt: null, updatedAt: now })
    .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId)));

  await broadcastOutboundEvent(
    c.env,
    db,
    accountId,
    "license.updated",
    {
      id: license.id,
      key: license.key,
      productId: license.productId,
      status: "active",
    },
    license.productId
  );

  return c.json({
    success: true,
    data: { message: "License reinstated" },
  });
});

// DELETE /api/v1/admin/licenses/:id/machines/:machineId
adminLicensesRouter.delete("/:id/machines/:machineId", requireRole(["owner", "admin", "member"]), async (c) => {
  const licenseId = c.req.param("id");
  const machineId = c.req.param("machineId");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  // Verify license belongs to tenant
  const license = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.id, licenseId), eq(licenses.accountId, accountId)))
    .get();

  if (!license) {
    throw new NotFoundError("License not found");
  }

  const machine = await db
    .select()
    .from(machines)
    .where(and(eq(machines.id, machineId), eq(machines.licenseId, licenseId)))
    .get();

  if (machine) {
    await db
      .delete(machines)
      .where(and(eq(machines.id, machineId), eq(machines.licenseId, licenseId)));

    await broadcastOutboundEvent(
      c.env,
      db,
      accountId,
      "client.deactivated",
      {
        licenseId: license.id,
        key: license.key,
        machineId: machine.id,
        fingerprint: machine.fingerprint,
      },
      license.productId
    );
  }

  return c.json({
    success: true,
    data: { message: "Machine seat unbound successfully" },
  });
});
