import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../types";
import { adminCsrf, requireExactOrigin, requireRole } from "../middleware/auth";
import { ConflictError, NotFoundError } from "../middleware/error";
import { prepareAuditInsert } from "../services/identity/audit";
import { requestIp } from "../services/identity/session";

export const adminCustomersRouter = new Hono<AppContext>();

const UpdateCustomerSchema = z.object({
  email: z.string().email().max(320).optional(),
  name: z.string().trim().min(1).max(120).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

function mutationGuards() {
  return [requireExactOrigin, adminCsrf, requireRole(["owner", "admin"])] as const;
}

adminCustomersRouter.get("/", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const result = await c.env.DB
    .prepare(
      `SELECT id, email, name, status, created_at, updated_at
       FROM customers WHERE account_id = ?1 ORDER BY created_at DESC`
    )
    .bind(c.get("accountId")!)
    .all();
  return c.json({ success: true, data: { items: result.results } });
});

adminCustomersRouter.get("/:customerId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const accountId = c.get("accountId")!;
  const customerId = c.req.param("customerId");
  const customer = await c.env.DB
    .prepare(
      `SELECT id, email, name, status, created_at, updated_at
       FROM customers WHERE account_id = ?1 AND id = ?2 LIMIT 1`
    )
    .bind(accountId, customerId)
    .all();
  if (!customer.results[0]) throw new NotFoundError("Customer not found");
  const licenses = await c.env.DB
    .prepare(
      `SELECT id, product_id, status, license_model, renewal_mode, expires_at, updates_until, created_at
       FROM licenses WHERE account_id = ?1 AND customer_id = ?2 ORDER BY created_at DESC`
    )
    .bind(accountId, customerId)
    .all();
  return c.json({ success: true, data: { customer: customer.results[0], licenses: licenses.results } });
});

adminCustomersRouter.patch("/:customerId", ...mutationGuards(), async (c) => {
  const input = UpdateCustomerSchema.parse(await c.req.json());
  const accountId = c.get("accountId")!;
  const actorId = c.get("userId")!;
  const customerId = c.req.param("customerId");
  const currentResult = await c.env.DB
    .prepare(`SELECT id, email, name FROM customers WHERE account_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(accountId, customerId)
    .all<any>();
  const current = currentResult.results[0];
  if (!current) throw new NotFoundError("Customer not found");
  const email = input.email?.trim().toLowerCase();
  if (email && email !== String(current.email).toLowerCase()) {
    const conflict = await c.env.DB
      .prepare(`SELECT id FROM customers WHERE account_id = ?1 AND email = ?2 COLLATE NOCASE AND id <> ?3 LIMIT 1`)
      .bind(accountId, email, customerId)
      .all<{ id: string }>();
    if (conflict.results[0]) throw new ConflictError("CUSTOMER_EMAIL_CONFLICT", "Email belongs to another Customer");
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    c.env.DB
      .prepare(
        `UPDATE customers SET email = COALESCE(?1, email),
             name = CASE WHEN ?2 = 1 THEN ?3 ELSE name END, updated_at = ?4
         WHERE account_id = ?5 AND id = ?6`
      )
      .bind(email ?? null, input.name !== undefined ? 1 : 0, input.name ?? null, now, accountId, customerId),
  ];
  if (email && email !== String(current.email).toLowerCase()) {
    statements.push(...revokeCustomerAccessStatements(c.env.DB, accountId, customerId, now));
  }
  statements.push(
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: actorId },
      action: "admin.customer.updated",
      resourceType: "customer",
      resourceId: customerId,
      details: { previous: { email: current.email, name: current.name }, changed: input },
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
      now,
    })
  );
  await c.env.DB.batch(statements);
  const updated = await c.env.DB
    .prepare(`SELECT id, email, name, status, created_at, updated_at FROM customers WHERE account_id = ?1 AND id = ?2`)
    .bind(accountId, customerId)
    .all();
  return c.json({ success: true, data: updated.results[0] });
});

function revokeCustomerAccessStatements(
  db: D1Database,
  accountId: string,
  customerId: string,
  now: string
): D1PreparedStatement[] {
  return [
    db.prepare(
      `UPDATE outbound_deliveries
       SET status = CASE WHEN status = 'accepted' THEN status ELSE 'payload_expired' END,
           payload_ciphertext = NULL, payload_cleared_at = COALESCE(payload_cleared_at, ?1),
           next_attempt_at = NULL, updated_at = ?1
       WHERE account_id = ?2
         AND id IN (
           SELECT delivery_id FROM customer_login_challenges
           WHERE account_id = ?2 AND customer_id = ?3 AND consumed_at IS NULL AND revoked_at IS NULL
         )`
    ).bind(now, accountId, customerId),
    db.prepare(
      `UPDATE customer_login_challenges SET revoked_at = ?1
       WHERE account_id = ?2 AND customer_id = ?3 AND consumed_at IS NULL AND revoked_at IS NULL`
    ).bind(now, accountId, customerId),
    db.prepare(
      `UPDATE customer_sessions SET revoked_at = ?1
       WHERE account_id = ?2 AND customer_id = ?3 AND revoked_at IS NULL`
    ).bind(now, accountId, customerId),
  ];
}

async function setCustomerStatus(c: any, status: "active" | "disabled") {
  const accountId = c.get("accountId") as string;
  const actorId = c.get("userId") as string;
  const customerId = c.req.param("customerId");
  const exists = await c.env.DB
    .prepare(`SELECT id FROM customers WHERE account_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(accountId, customerId)
    .all();
  if (!exists.results[0]) throw new NotFoundError("Customer not found");
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    c.env.DB
      .prepare(`UPDATE customers SET status = ?1, updated_at = ?2 WHERE account_id = ?3 AND id = ?4`)
      .bind(status, now, accountId, customerId),
  ];
  if (status === "disabled") statements.push(...revokeCustomerAccessStatements(c.env.DB, accountId, customerId, now));
  statements.push(
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: actorId },
      action: status === "disabled" ? "admin.customer.disabled" : "admin.customer.enabled",
      resourceType: "customer",
      resourceId: customerId,
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
      now,
    })
  );
  await c.env.DB.batch(statements);
  return c.json({ success: true, data: { id: customerId, status } });
}

adminCustomersRouter.post("/:customerId/disable", ...mutationGuards(), (c) => setCustomerStatus(c, "disabled"));
adminCustomersRouter.post("/:customerId/enable", ...mutationGuards(), (c) => setCustomerStatus(c, "active"));

adminCustomersRouter.post("/:customerId/sessions/revoke", ...mutationGuards(), async (c) => {
  const accountId = c.get("accountId")!;
  const actorId = c.get("userId")!;
  const customerId = c.req.param("customerId");
  const exists = await c.env.DB
    .prepare(`SELECT id FROM customers WHERE account_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(accountId, customerId)
    .all<{ id: string }>();
  if (!exists.results[0]) throw new NotFoundError("Customer not found");
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE customer_sessions SET revoked_at = ?1
         WHERE account_id = ?2 AND customer_id = ?3 AND revoked_at IS NULL`
      )
      .bind(now, accountId, customerId),
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: actorId },
      action: "admin.customer.sessions_revoked",
      resourceType: "customer",
      resourceId: customerId,
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
      now,
    }),
  ]);
  return c.json({ success: true, data: { revoked: true } });
});
