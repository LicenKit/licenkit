import { Hono } from "hono";
import { eq, and, desc, sql, like, or } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { auditLogs } from "../../infra/db/schema";

export const adminAuditRouter = new Hono<AppContext>();

/**
 * GET /api/v1/admin/audit-logs
 * Retrieves paginated audit logs with mandatory database pushdown for filtering.
 * Strictly avoids full in-memory table scans.
 */
adminAuditRouter.get("/", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const offset = (page - 1) * limit;

  const action = c.req.query("action");
  const resourceType = c.req.query("resourceType") || c.req.query("resource_type");
  const userId = c.req.query("userId") || c.req.query("user_id");
  const query = c.req.query("query");

  // Pushdown SQL conditions directly to SQLite / D1
  const conditions = [eq(auditLogs.accountId, accountId)];

  if (action && action !== "all") {
    conditions.push(eq(auditLogs.action, action));
  }
  if (resourceType && resourceType !== "all") {
    conditions.push(eq(auditLogs.resourceType, resourceType));
  }
  if (userId && userId !== "all") {
    conditions.push(eq(auditLogs.userId, userId));
  }
  if (query && query.trim().length > 0) {
    const term = `%${query.trim()}%`;
    conditions.push(
      or(
        like(auditLogs.userEmail, term),
        like(auditLogs.action, term),
        like(auditLogs.resourceId, term)
      )!
    );
  }

  const whereClause = and(...conditions);

  // 1. Exact count pushed down to DB
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditLogs)
    .where(whereClause)
    .get();

  const total = Number(countResult?.count || 0);

  // 2. Paginated rows ordered by createdAt desc pushed down to DB
  const rows = await db
    .select()
    .from(auditLogs)
    .where(whereClause)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  const items = rows.map((r) => {
    let parsedDetails = {};
    try {
      parsedDetails = JSON.parse(r.details || "{}");
    } catch {
      parsedDetails = { raw: r.details };
    }
    return {
      id: r.id,
      accountId: r.accountId,
      userId: r.userId,
      userEmail: r.userEmail,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      details: parsedDetails,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt,
    };
  });

  const totalPages = Math.ceil(total / limit);

  return c.json({
    success: true,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        totalItems: total,
        totalPages,
        hasNext: page < totalPages,
      },
    },
  });
});
