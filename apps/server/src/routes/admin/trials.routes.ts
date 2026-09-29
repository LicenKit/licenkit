import { Hono } from "hono";
import { and, desc, eq, gt, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { products, trialClaims } from "../../infra/db/schema";
import { requireRole } from "../../middleware/auth";

export const adminTrialsRouter = new Hono<AppContext>();

const TrialListQuery = z.object({
  product_id: z.string().min(1).optional(),
  status: z.enum(["active", "expired", "revoked"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

// GET /api/v1/admin/trials
adminTrialsRouter.get("/", requireRole(["owner", "admin"]), async (c) => {
  const { product_id: productId, status, page, limit } = TrialListQuery.parse(c.req.query());
  const db = getTenantDB(c);
  const now = new Date().toISOString();
  const conditions: SQL[] = [eq(trialClaims.instanceId, c.get("instanceId")!)];

  if (productId) conditions.push(eq(trialClaims.productId, productId));
  if (status === "active") {
    conditions.push(isNull(trialClaims.revokedAt), gt(trialClaims.expiresAt, now));
  } else if (status === "expired") {
    conditions.push(isNull(trialClaims.revokedAt), lte(trialClaims.expiresAt, now));
  } else if (status === "revoked") {
    conditions.push(isNotNull(trialClaims.revokedAt));
  }
  const where = and(...conditions)!;

  const totalRow = await db.select({ count: sql<number>`count(*)` })
    .from(trialClaims).where(where).get();
  const rows = await db.select({
    id: trialClaims.id,
    productId: trialClaims.productId,
    productName: products.name,
    claimedAt: trialClaims.claimedAt,
    expiresAt: trialClaims.expiresAt,
    lastValidatedAt: trialClaims.lastValidatedAt,
    revokedAt: trialClaims.revokedAt,
  }).from(trialClaims)
    .innerJoin(products, and(
      eq(products.instanceId, trialClaims.instanceId),
      eq(products.id, trialClaims.productId),
    ))
    .where(where)
    .orderBy(desc(trialClaims.claimedAt), desc(trialClaims.id))
    .limit(limit).offset((page - 1) * limit).all();
  const total = totalRow?.count ?? 0;

  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: {
    items: rows.map((row) => ({
      id: row.id,
      product_id: row.productId,
      product_name: row.productName,
      status: row.revokedAt ? "revoked" : row.expiresAt <= now ? "expired" : "active",
      claimed_at: row.claimedAt,
      expires_at: row.expiresAt,
      last_validated_at: row.lastValidatedAt,
      revoked_at: row.revokedAt,
    })),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  } });
});
