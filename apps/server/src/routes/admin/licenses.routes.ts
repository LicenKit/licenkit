import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq, and, desc, sql, like, or } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { licenses, policies, machines, products } from "../../infra/db/schema";
import { generateLicenseKey, normalizeLicenseKey, hashLicenseKey } from "../../infra/crypto";
import { broadcastOutboundEvent } from "../../infra/events/broadcast";
import { requireRole } from "../../middleware/auth";
import { NotFoundError, AppError, ConflictError } from "../../middleware/error";
import { recordAuditLog } from "../../infra/audit";

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
    keyHash: l.keyHash,
    key: l.key || null,
    customerEmail: l.customerEmail,
    source: l.source || "manual",
    status: l.status,
    revokeReason: l.revokeReason || null,
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
  const source = c.req.query("source");
  const seatStatus = c.req.query("seatStatus") || c.req.query("seat_status");
  const customerEmail = c.req.query("customerEmail") || c.req.query("customer_email");
  const search = c.req.query("query");

  // Build filter conditions
  const conditions = [eq(licenses.accountId, accountId)];
  if (productId) conditions.push(eq(licenses.productId, productId));
  if (policyId) conditions.push(eq(licenses.policyId, policyId));
  if (status && status !== "all") conditions.push(eq(licenses.status, status));
  if (source && source !== "all") conditions.push(eq(licenses.source, source));
  if (customerEmail) conditions.push(eq(licenses.customerEmail, customerEmail.toLowerCase().trim()));
  if (search) {
    const trimmed = search.trim();
    const term = `%${trimmed}%`;
    const normalized = normalizeLicenseKey(trimmed);
    const hashed = await hashLicenseKey(normalized);
    conditions.push(or(like(licenses.id, term), like(licenses.customerEmail, term), eq(licenses.keyHash, hashed))!);
  }
  if (seatStatus === "unused") {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM machines WHERE machines.license_id = ${licenses.id})`);
  } else if (seatStatus === "in_use") {
    conditions.push(sql`EXISTS (SELECT 1 FROM machines WHERE machines.license_id = ${licenses.id})`);
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
      keyHash: licenses.keyHash,
      customerEmail: licenses.customerEmail,
      source: licenses.source,
      status: licenses.status,
      revokeReason: licenses.revokeReason,
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

export function escapeCsvCell(val: any): string {
  if (val === null || val === undefined) return "";
  let s = String(val);
  // Formula Injection prevention: prepend single quote if cell begins with =, +, -, @, \t, \r
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r") || s.startsWith("'")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// GET /api/v1/admin/licenses/export
adminLicensesRouter.get("/export", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const productId = c.req.query("productId") || c.req.query("product_id");
  const policyId = c.req.query("policyId") || c.req.query("policy_id");
  const status = c.req.query("status");
  const source = c.req.query("source");
  const seatStatus = c.req.query("seatStatus") || c.req.query("seat_status");
  const customerEmail = c.req.query("customerEmail") || c.req.query("customer_email");
  const search = c.req.query("query");

  const conditions = [eq(licenses.accountId, accountId)];
  if (productId) conditions.push(eq(licenses.productId, productId));
  if (policyId) conditions.push(eq(licenses.policyId, policyId));
  if (status && status !== "all") conditions.push(eq(licenses.status, status));
  if (source && source !== "all") conditions.push(eq(licenses.source, source));
  if (customerEmail) conditions.push(eq(licenses.customerEmail, customerEmail.toLowerCase().trim()));
  if (search) {
    const trimmed = search.trim();
    const term = `%${trimmed}%`;
    const normalized = normalizeLicenseKey(trimmed);
    const hashed = await hashLicenseKey(normalized);
    conditions.push(or(like(licenses.id, term), like(licenses.customerEmail, term), eq(licenses.keyHash, hashed))!);
  }
  if (seatStatus === "unused") {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM machines WHERE machines.license_id = ${licenses.id})`);
  } else if (seatStatus === "in_use") {
    conditions.push(sql`EXISTS (SELECT 1 FROM machines WHERE machines.license_id = ${licenses.id})`);
  }

  const combinedCondition = and(...conditions);

  const list = await db
    .select({
      id: licenses.id,
      keyHash: licenses.keyHash,
      customerEmail: licenses.customerEmail,
      source: licenses.source,
      status: licenses.status,
      revokeReason: licenses.revokeReason,
      productName: products.name,
      policyName: policies.name,
      maxMachines: policies.maxMachines,
      machinesCount: sql<number>`(SELECT count(*) FROM machines WHERE machines.license_id = ${licenses.id})`,
      expiresAt: licenses.expiresAt,
      createdAt: licenses.createdAt,
    })
    .from(licenses)
    .leftJoin(products, eq(licenses.productId, products.id))
    .leftJoin(policies, eq(licenses.policyId, policies.id))
    .where(combinedCondition)
    .orderBy(desc(licenses.createdAt))
    .all();

  const headers = [
    "License ID",
    "Key Hash",
    "Product",
    "Policy",
    "Customer Email",
    "Source",
    "Status",
    "Revoke Reason",
    "Seats Occupied",
    "Max Seats",
    "Expires At",
    "Created At",
  ];

  const rows = list.map((item) => [
    escapeCsvCell(item.id),
    escapeCsvCell(item.keyHash),
    escapeCsvCell(item.productName || ""),
    escapeCsvCell(item.policyName || ""),
    escapeCsvCell(item.customerEmail || ""),
    escapeCsvCell(item.source),
    escapeCsvCell(item.status),
    escapeCsvCell(item.revokeReason || ""),
    escapeCsvCell(item.machinesCount ?? 0),
    escapeCsvCell(item.maxMachines ?? 1),
    escapeCsvCell(item.expiresAt || "Perpetual"),
    escapeCsvCell(item.createdAt),
  ]);

  const csvContent = "\uFEFF" + [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");

  const today = new Date().toISOString().slice(0, 10);
  return new Response(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="licenses-export-${today}.csv"`,
    },
  });
});

export async function cleanExpiredUnusedLicenses(db: any, targetAccountId?: string): Promise<number> {
  const now = new Date().toISOString();
  // SQL pushdown: source = 'manual', status = 'active', created_at <= datetime('now', '-30 days'),
  // and no machine seats bound
  const conditions = [
    eq(licenses.status, "active"),
    eq(licenses.source, "manual"),
    sql`datetime(${licenses.createdAt}) <= datetime('now', '-30 days')`,
    sql`NOT EXISTS (SELECT 1 FROM machines WHERE machines.license_id = ${licenses.id})`,
  ];
  if (targetAccountId) {
    conditions.push(eq(licenses.accountId, targetAccountId));
  }

  const result = await db
    .update(licenses)
    .set({
      status: "revoked",
      revokeReason: "EXPIRED_30_DAYS_UNUSED",
      updatedAt: now,
    })
    .where(and(...conditions))
    .run();

  return result?.meta?.changes ?? 0;
}

// POST /api/v1/admin/licenses/clean-expired-unused
adminLicensesRouter.post("/clean-expired-unused", requireRole(["owner", "admin"]), async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const cleanedCount = await cleanExpiredUnusedLicenses(db, accountId);

  await recordAuditLog({
    c,
    action: "license.cleanup_expired_unused",
    resourceType: "license",
    resourceId: "batch_cleanup",
    details: { cleanedCount },
  });

  return c.json({
    success: true,
    data: {
      cleanedCount,
      message: `Cleaned up ${cleanedCount} expired unused licenses (older than 30 days).`,
    },
  });
});

const IssueLicenseSchema = z.object({
  productId: z.string(),
  policyId: z.string(),
  customerEmail: z.string().email().optional().nullable(),
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

  // 3. Query pushdown: check unused manual licenses limit (100)
  const unusedManualResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(licenses)
    .where(
      and(
        eq(licenses.accountId, accountId),
        eq(licenses.source, "manual"),
        eq(licenses.status, "active"),
        sql`NOT EXISTS (SELECT 1 FROM machines WHERE machines.license_id = ${licenses.id})`
      )
    )
    .get();

  const currentUnusedCount = unusedManualResult?.count || 0;
  if (currentUnusedCount >= 100) {
    throw new AppError(
      "MANUAL_LICENSE_LIMIT_EXCEEDED",
      "Unused manual licenses limit (100) reached. Activate or clean up existing keys before issuing new ones.",
      400
    );
  }

  const licenseId = `lic_${ulid().toLowerCase()}`;
  const key = generateLicenseKey();
  const keyHash = await hashLicenseKey(normalizeLicenseKey(key));
  const now = new Date();

  let expiresAt: string | null = null;
  if (input.expiresAt !== undefined) {
    expiresAt = input.expiresAt;
  } else if (policy.duration) {
    expiresAt = new Date(now.getTime() + policy.duration * 1000).toISOString();
  }

  const email = input.customerEmail ? input.customerEmail.toLowerCase().trim() : null;

  try {
    await db.insert(licenses).values({
      id: licenseId,
      accountId,
      productId: input.productId,
      policyId: input.policyId,
      keyHash,
      customerEmail: email,
      source: "manual",
      status: "active",
      revokeReason: null,
      metadata: JSON.stringify(input.metadata),
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  } catch (err: any) {
    if (err?.message?.includes("UNIQUE") || err?.message?.includes("constraint")) {
      throw new ConflictError(
        "KEY_EXISTS",
        "A generated license key collision occurred. Please try again."
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
      customerEmail: email,
      productId: input.productId,
      policyId: input.policyId,
      status: "active",
      expiresAt,
    },
    input.productId
  );

  await recordAuditLog({
    c,
    action: "license.create",
    resourceType: "license",
    resourceId: licenseId,
    details: {
      customerEmail: email,
      productId: input.productId,
      policyId: input.policyId,
      expiresAt,
    },
  });

  return c.json(
    {
      success: true,
      data: {
        id: licenseId,
        key,
        customerEmail: email,
        source: "manual",
        expiresAt,
        status: "active",
        productName: product.name,
        policyName: policy.name,
      },
    },
    201
  );
});

const BatchIssueLicenseSchema = z.object({
  productId: z.string(),
  policyId: z.string(),
  count: z.number().int().min(1).max(10),
  customerEmail: z.string().email().optional().nullable(),
  metadata: z.record(z.any()).default({}),
});

// POST /api/v1/admin/licenses/batch
adminLicensesRouter.post("/batch", requireRole(["owner", "admin", "member"]), async (c) => {
  const body = await c.req.json();
  const input = BatchIssueLicenseSchema.parse(body);

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

  // 3. Query pushdown: check unused manual licenses limit (100)
  const unusedManualResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(licenses)
    .where(
      and(
        eq(licenses.accountId, accountId),
        eq(licenses.source, "manual"),
        eq(licenses.status, "active"),
        sql`NOT EXISTS (SELECT 1 FROM machines WHERE machines.license_id = ${licenses.id})`
      )
    )
    .get();

  const currentUnusedCount = unusedManualResult?.count || 0;
  if (currentUnusedCount >= 100) {
    throw new AppError(
      "MANUAL_LICENSE_LIMIT_EXCEEDED",
      "Unused manual licenses limit (100) reached. Activate or clean up existing keys before issuing new ones.",
      400
    );
  }

  // Auto-truncation: generate up to remaining capacity, up to 100 total
  const remainingQuota = 100 - currentUnusedCount;
  const actualCount = Math.min(input.count, remainingQuota);

  const now = new Date();
  let expiresAt: string | null = null;
  if (policy.duration) {
    expiresAt = new Date(now.getTime() + policy.duration * 1000).toISOString();
  }

  const batchId = `batch_${ulid().toLowerCase()}`;
  const email = input.customerEmail ? input.customerEmail.toLowerCase().trim() : null;

  const newLicenses: any[] = [];
  const clientResponseItems: any[] = [];
  for (let i = 0; i < actualCount; i++) {
    const licenseId = `lic_${ulid().toLowerCase()}`;
    const key = generateLicenseKey();
    const keyHash = await hashLicenseKey(normalizeLicenseKey(key));
    newLicenses.push({
      id: licenseId,
      accountId,
      productId: input.productId,
      policyId: input.policyId,
      keyHash,
      customerEmail: email,
      source: "manual",
      status: "active",
      revokeReason: null,
      metadata: JSON.stringify({
        ...(input.metadata || {}),
        batchId,
      }),
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    clientResponseItems.push({
      id: licenseId,
      accountId,
      productId: input.productId,
      productName: product.name,
      policyId: input.policyId,
      policyName: policy.name,
      maxMachines: policy.maxMachines,
      scheme: policy.scheme,
      keyHash,
      key, // returned once for immediate download
      customerEmail: email,
      source: "manual",
      status: "active",
      revokeReason: null,
      metadata: { ...(input.metadata || {}), batchId },
      expiresAt,
      suspendedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      machinesCount: 0,
    });
  }

  await db.insert(licenses).values(newLicenses);

  for (const lic of clientResponseItems) {
    await broadcastOutboundEvent(
      c.env,
      db,
      accountId,
      "license.created",
      {
        id: lic.id,
        key: lic.key,
        customerEmail: email,
        productId: input.productId,
        policyId: input.policyId,
        status: "active",
        expiresAt,
      },
      input.productId
    );
  }

  await recordAuditLog({
    c,
    action: "license.batch_create",
    resourceType: "license",
    resourceId: batchId,
    details: {
      productId: input.productId,
      policyId: input.policyId,
      requestedCount: input.count,
      actualCount,
      truncated: actualCount < input.count,
      batchId,
    },
  });

  return c.json(
    {
      success: true,
      data: {
        items: clientResponseItems.map(formatLicense),
        batchId,
        requestedCount: input.count,
        actualCount,
        truncated: actualCount < input.count,
        notice:
          actualCount < input.count
            ? `Requested ${input.count} licenses, but only ${actualCount} generated due to the 100 unused manual license quota.`
            : null,
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
      keyHash: licenses.keyHash,
      customerEmail: licenses.customerEmail,
      source: licenses.source,
      status: licenses.status,
      revokeReason: licenses.revokeReason,
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
  revokeReason: z.string().nullable().optional(),
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
      updateData.revokeReason = null;
    } else if (input.status === "revoked") {
      updateData.revokeReason = input.revokeReason !== undefined ? input.revokeReason : license.revokeReason;
      // If revoked, cascade delete machines
      await db.delete(machines).where(eq(machines.licenseId, id));
    }
  } else if (input.revokeReason !== undefined) {
    updateData.revokeReason = input.revokeReason;
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
      productId: license.productId,
      status: input.status || license.status,
      expiresAt: input.expiresAt !== undefined ? input.expiresAt : license.expiresAt,
    },
    license.productId
  );

  await recordAuditLog({
    c,
    action: "license.update",
    resourceType: "license",
    resourceId: id,
    details: {
      status: input.status || license.status,
      expiresAt: input.expiresAt,
    },
  });

  return c.json({
    success: true,
    data: { message: "License updated successfully" },
  });
});

// POST /api/v1/admin/licenses/:id/rotate-key
adminLicensesRouter.post("/:id/rotate-key", requireRole(["owner", "admin", "member"]), async (c) => {
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

  const newKey = generateLicenseKey();
  const keyHash = await hashLicenseKey(normalizeLicenseKey(newKey));

  // Atomically update keyHash and clear all machine seat bindings
  await db.batch([
    db
      .update(licenses)
      .set({ keyHash, updatedAt: now })
      .where(and(eq(licenses.id, id), eq(licenses.accountId, accountId))),
    db.delete(machines).where(eq(machines.licenseId, id)),
  ]);

  await recordAuditLog({
    c,
    action: "license.rotate_key",
    resourceType: "license",
    resourceId: id,
    details: {
      rotatedAt: now,
    },
  });

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

  let reason: string | null = null;
  try {
    const body = await c.req.json().catch(() => null);
    if (body && typeof body.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim();
    }
  } catch {
    // body is optional
  }

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
      .set({ status: "revoked", revokeReason: reason, updatedAt: now })
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
      productId: license.productId,
      status: "revoked",
      revokeReason: reason,
    },
    license.productId
  );

  await recordAuditLog({
    c,
    action: "license.revoke",
    resourceType: "license",
    resourceId: id,
    details: {
      productId: license.productId,
      revokeReason: reason,
    },
  });

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
      productId: license.productId,
      status: "suspended",
    },
    license.productId
  );

  await recordAuditLog({
    c,
    action: "license.suspend",
    resourceType: "license",
    resourceId: id,
    details: {
      suspendedAt: now,
    },
  });

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
      productId: license.productId,
      status: "active",
    },
    license.productId
  );

  await recordAuditLog({
    c,
    action: "license.reinstate",
    resourceType: "license",
    resourceId: id,
    details: {
      reinstatedAt: now,
    },
  });

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
        machineId: machine.id,
        fingerprint: machine.fingerprint,
      },
      license.productId
    );

    await recordAuditLog({
      c,
      action: "license.machine_unbind",
      resourceType: "license",
      resourceId: licenseId,
      details: {
        machineId,
        fingerprint: machine.fingerprint,
        platform: machine.platform,
        name: machine.name,
      },
    });
  }

  return c.json({
    success: true,
    data: { message: "Machine seat unbound successfully" },
  });
});
