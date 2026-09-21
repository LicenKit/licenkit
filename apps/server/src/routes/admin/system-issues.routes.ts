import { Hono } from "hono";
import type { AppContext } from "../../types";
import { requireRole } from "../../middleware/auth";
import { adminCsrf, requireExactOrigin } from "../../middleware/auth";
import { AppError, NotFoundError } from "../../middleware/error";
import { listSystemIssues } from "../../services/operations/system-issues";
import { prepareAuditInsert } from "../../services/identity/audit";
import { requestIp } from "../../services/identity/session";
import { toSnakeCaseJson } from "./snake-case-json";

export const adminSystemIssuesRouter = new Hono<AppContext>();

function instanceId(c: any): string {
  const value = c.get("instanceId");
  if (!value) {
    throw new AppError(
      "ADMIN_INSTANCE_CONTEXT_MISSING",
      "Authenticated instance context is required.",
      500,
    );
  }
  return value;
}

adminSystemIssuesRouter.get(
  "/issues",
  requireRole(["owner", "admin", "member", "viewer"]),
  async (c) => {
    const data = await listSystemIssues({
      db: c.env.DB,
      instanceId: instanceId(c),
    });
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: toSnakeCaseJson(data) });
  },
);

adminSystemIssuesRouter.post(
  "/issues/:issueId/process",
  requireExactOrigin,
  adminCsrf,
  requireRole(["owner", "admin"]),
  async (c) => {
    const now = new Date().toISOString();
    const issueId = c.req.param("issueId");
    const result = await c.env.DB.prepare(
      `UPDATE system_issues
       SET status = 'processed', processed_at = ?1,
           processed_by_user_id = ?2
       WHERE instance_id = ?3 AND id = ?4 AND status = 'pending'`,
    ).bind(now, c.get("userId"), instanceId(c), issueId).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new NotFoundError("Pending System Issue not found");
    }
    await c.env.DB.batch([
      prepareAuditInsert({
        db: c.env.DB,
        instanceId: instanceId(c),
        actor: { type: "user", id: c.get("userId")! },
        action: "system_issue.process",
        resourceType: "system_issue",
        resourceId: issueId,
        requestId: c.get("requestId"),
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    return c.json({ success: true, data: { id: issueId, status: "processed", processed_at: now } });
  },
);
