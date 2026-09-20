import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../types";
import { requireRole } from "../../middleware/auth";
import { AppError } from "../../middleware/error";
import { requestIp } from "../../services/identity/session";
import {
  getSystemIssueDetail,
  listSystemIssues,
  resolveSystemIssue,
  retryResolvedSystemIssueEvents,
} from "../../services/billing/system-issues";

export const adminSystemIssuesRouter = new Hono<AppContext>();

const ResolveSystemIssueSchema = z.object({
  resolutionNote: z.string().trim().min(1).max(2_000),
  retryAffectedEvents: z.boolean(),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

const RetrySystemIssueEventsSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

function accountId(c: any): string {
  const value = c.get("accountId");
  if (!value) {
    throw new AppError(
      "ADMIN_ACCOUNT_CONTEXT_MISSING",
      "Authenticated account context is required.",
      500,
    );
  }
  return value;
}

function userId(c: any): string {
  const value = c.get("userId");
  if (!value) {
    throw new AppError(
      "ADMIN_USER_CONTEXT_MISSING",
      "Authenticated user context is required.",
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
      accountId: accountId(c),
    });
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data });
  },
);

adminSystemIssuesRouter.get(
  "/issues/:issueId",
  requireRole(["owner", "admin", "member", "viewer"]),
  async (c) => {
    const data = await getSystemIssueDetail({
      db: c.env.DB,
      accountId: accountId(c),
      issueId: c.req.param("issueId"),
    });
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data });
  },
);

adminSystemIssuesRouter.post(
  "/issues/:issueId/resolve",
  requireRole(["owner", "admin"]),
  async (c) => {
    const input = ResolveSystemIssueSchema.parse(await c.req.json());
    const data = await resolveSystemIssue({
      db: c.env.DB,
      env: c.env,
      accountId: accountId(c),
      issueId: c.req.param("issueId"),
      userId: userId(c),
      resolutionNote: input.resolutionNote,
      retryAffectedEvents: input.retryAffectedEvents,
      expectedUpdatedAt: input.expectedUpdatedAt,
      requestId: c.get("requestId") ?? null,
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data,
    });
  },
);

adminSystemIssuesRouter.post(
  "/issues/:issueId/retry-affected-events",
  requireRole(["owner", "admin"]),
  async (c) => {
    const input = RetrySystemIssueEventsSchema.parse(await c.req.json());
    const data = await retryResolvedSystemIssueEvents({
      db: c.env.DB,
      accountId: accountId(c),
      issueId: c.req.param("issueId"),
      userId: userId(c),
      expectedUpdatedAt: input.expectedUpdatedAt,
      requestId: c.get("requestId") ?? null,
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
    });
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data });
  },
);
