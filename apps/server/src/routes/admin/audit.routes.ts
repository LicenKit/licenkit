import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, sql, like, or } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { auditLogs } from "../../infra/db/schema";
import { requireRole } from "../../middleware/auth";
import { toSnakeCaseJson } from "./snake-case-json";

export const adminAuditRouter = new Hono<AppContext>();

const AuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  action: z.string().optional(),
  resource_type: z.string().optional(),
  actor_id: z.string().optional(),
  query: z.string().optional(),
}).strict();

/**
 * GET /api/v1/admin/audit-logs
 * Retrieves paginated audit logs with mandatory database pushdown for filtering.
 * Strictly avoids full in-memory table scans.
 */
adminAuditRouter.get("/", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const db = getTenantDB(c);
  const instanceId = c.get("instanceId")!;
  const userId = c.get("userId")!;
  const role = c.get("instanceRole")!;

  const input = AuditQuerySchema.parse(c.req.query());
  const page = input.page;
  const limit = input.limit;
  const offset = (page - 1) * limit;

  const action = input.action;
  const resourceType = input.resource_type;
  const actorId = input.actor_id;
  const query = input.query;

  // Pushdown SQL conditions directly to SQLite / D1
  const conditions = [
    eq(auditLogs.scopeType, "instance"),
    eq(auditLogs.instanceId, instanceId),
  ];

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
      resource_type: r.resourceType,
      resource_id: r.resourceId,
      created_at: r.createdAt,
    };
    if (role === "viewer") return summary;
    return {
      ...summary,
      instance_id: r.instanceId,
      actor: {
        ...summary.actor,
        user_id: r.actorUserId,
        customer_id: r.actorCustomerId,
      },
      request_id: r.requestId,
      details: toSnakeCaseJson(parsedDetails),
      ip: r.ip,
      user_agent: r.userAgent,
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
        total_items: total,
        total_pages: totalPages,
        has_next: page < totalPages,
      },
    },
  });
});
