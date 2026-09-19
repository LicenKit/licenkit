import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../types";
import { adminCsrf, requireExactOrigin, requireRole } from "../../middleware/auth";
import { NotFoundError } from "../../middleware/error";
import { prepareAuditInsert } from "../../services/identity/audit";
import { requestIp } from "../../services/identity/session";

export const adminSettingsRouter = new Hono<AppContext>();
export const adminAccountRouter = adminSettingsRouter;

const UpdateAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  defaultSubscriptionPaymentGraceSeconds: z.number().int().min(0).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

adminSettingsRouter.get("/", requireRole(["owner"]), async (c) => {
  const accountId = c.get("accountId")!;
  const result = await c.env.DB
    .prepare(
      `SELECT id, name, slug, default_subscription_payment_grace_seconds,
              status, created_at, updated_at
       FROM accounts WHERE id = ?1 LIMIT 1`
    )
    .bind(accountId)
    .all<any>();
  const account = result.results[0];
  if (!account) throw new NotFoundError("Account not found");
  return c.json({
    success: true,
    data: {
      id: account.id,
      name: account.name,
      slug: account.slug,
      defaultSubscriptionPaymentGraceSeconds: account.default_subscription_payment_grace_seconds,
      status: account.status,
      createdAt: account.created_at,
      updatedAt: account.updated_at,
    },
  });
});

adminSettingsRouter.patch(
  "/",
  requireExactOrigin,
  adminCsrf,
  requireRole(["owner"]),
  async (c) => {
    const input = UpdateAccountSchema.parse(await c.req.json());
    const accountId = c.get("accountId")!;
    const actorId = c.get("userId")!;
    const currentResult = await c.env.DB
      .prepare(`SELECT name, default_subscription_payment_grace_seconds FROM accounts WHERE id = ?1 LIMIT 1`)
      .bind(accountId)
      .all<{ name: string; default_subscription_payment_grace_seconds: number }>();
    const current = currentResult.results[0];
    if (!current) throw new NotFoundError("Account not found");
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE accounts
           SET name = COALESCE(?1, name),
               default_subscription_payment_grace_seconds = COALESCE(?2, default_subscription_payment_grace_seconds),
               updated_at = ?3
           WHERE id = ?4`
        )
        .bind(input.name ?? null, input.defaultSubscriptionPaymentGraceSeconds ?? null, now, accountId),
      prepareAuditInsert({
        db: c.env.DB,
        accountId,
        actor: { type: "user", id: actorId },
        action: "admin.account.updated",
        resourceType: "account",
        resourceId: accountId,
        details: {
          previous: {
            name: current.name,
            defaultSubscriptionPaymentGraceSeconds: current.default_subscription_payment_grace_seconds,
          },
          changed: input,
        },
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    const updated = await c.env.DB
      .prepare(
        `SELECT id, name, slug, default_subscription_payment_grace_seconds, status, updated_at
         FROM accounts WHERE id = ?1`
      )
      .bind(accountId)
      .all<any>();
    const row = updated.results[0];
    return c.json({
      success: true,
      data: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        defaultSubscriptionPaymentGraceSeconds: row.default_subscription_payment_grace_seconds,
        status: row.status,
        updatedAt: row.updated_at,
      },
    });
  }
);
