import { Hono } from "hono";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { products, licenses, machines } from "../../infra/db/schema";

export const adminStatsRouter = new Hono<AppContext>();

// GET /api/v1/admin/stats
adminStatsRouter.get("/", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 86400 * 1000);

  // 1. Total active products
  const productsResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .where(and(eq(products.accountId, accountId), eq(products.isActive, true)))
    .get();

  // 2. Total licenses
  const licensesResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(licenses)
    .where(eq(licenses.accountId, accountId))
    .get();

  // 3. Activated machines
  const machinesResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(machines)
    .innerJoin(licenses, eq(machines.licenseId, licenses.id))
    .where(eq(licenses.accountId, accountId))
    .get();

  // 4. Licenses expiring in next 30 days
  const expiringResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(licenses)
    .where(
      and(
        eq(licenses.accountId, accountId),
        eq(licenses.status, "active"),
        gte(licenses.expiresAt, now.toISOString()),
        lte(licenses.expiresAt, in30Days.toISOString())
      )
    )
    .get();

  return c.json({
    success: true,
    data: {
      totalProducts: productsResult?.count || 0,
      totalLicenses: licensesResult?.count || 0,
      activatedMachines: machinesResult?.count || 0,
      expiringSoon: expiringResult?.count || 0,
    },
  });
});
