import { Hono } from "hono";
import { eq, and, desc, sql, like, or } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { auditLogs } from "../../infra/db/schema";
import { requireRole } from "../../middleware/auth";

export const adminAuditRouter = new Hono<AppContext>();

/**
 * GET /api/v1/admin/audit-logs
 * Retrieves paginated audit logs with mandatory database pushdown for filtering.
 * Strictly avoids full in-memory table scans.
 */
adminAuditRouter.get("/", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const userId = c.get("userId")!;
  const role = c.get("userRole")!;

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const offset = (page - 1) * limit;

  const action = c.req.query("action");
  const resourceType = c.req.query("resourceType") || c.req.query("resource_type");
  const actorId = c.req.query("actorId") || c.req.query("actor_id") || c.req.query("userId") || c.req.query("user_id");
  const query = c.req.query("query");

  // Pushdown SQL conditions directly to SQLite / D1
  const conditions = [eq(auditLogs.accountId, accountId)];

  if (action && action !== "all") {
    conditions.push(eq(auditLogs.action, action));
  }
  if (resourceType && resourceType !== "all") {
    conditions.push(eq(auditLogs.resourceType, resourceType));
  }
  if (role === "member") {
    conditions.push(eq(auditLogs.actorUserId, userId));
  } else if (actorId && actorId !== "all") {
    conditions.push(
      or(eq(auditLogs.actorUserId, actorId), eq(auditLogs.actorCustomerId, actorId))!
    );
  }
  if (query && query.trim().length > 0) {
    const term = `%${query.trim()}%`;
    conditions.push(
      or(
        like(auditLogs.action, term),
        like(auditLogs.resourceId, term),
        like(auditLogs.detailsRedactedJson, term)
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
      parsedDetails = JSON.parse(r.detailsRedactedJson || "{}");
    } catch {
      parsedDetails = { raw: r.detailsRedactedJson };
    }
    const summary = {
      id: r.id,
      actor: {
        type: r.actorType,
      },
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      createdAt: r.createdAt,
    };
    if (role === "viewer") return summary;
    return {
      ...summary,
      accountId: r.accountId,
      actor: {
        ...summary.actor,
        userId: r.actorUserId,
        customerId: r.actorCustomerId,
      },
      requestId: r.requestId,
      details: parsedDetails,
      ip: r.ip,
      userAgent: r.userAgent,
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
