import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../types";
import { adminCsrf, requireAdminAppOrigin, requireRole } from "../middleware/auth";
import { ConflictError, NotFoundError } from "../middleware/error";
import { prepareAuditInsert } from "../services/identity/audit";
import { requestIp } from "../services/identity/session";

export const adminCustomersRouter = new Hono<AppContext>();

const UpdateCustomerSchema = z.object({
  email: z.string().email().max(320).optional(),
  name: z.string().trim().min(1).max(120).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

function mutationGuards() {
  return [requireAdminAppOrigin, adminCsrf, requireRole(["owner", "admin"])] as const;
}

adminCustomersRouter.get("/", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const queryInput = z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    status: z.enum(["active", "disabled"]).optional(),
    query: z.string().optional(),
  }).strict().parse(c.req.query());

  const page = Math.max(1, Number.parseInt(queryInput.page ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(queryInput.limit ?? "20", 10) || 20));
  const offset = (page - 1) * limit;

  const instanceId = c.get("instanceId")!;
  const conditions: string[] = ["instance_id = ?1"];
  const bindings: unknown[] = [instanceId];
  let bindIndex = 2;

  if (queryInput.status) {
    conditions.push(`status = ?${bindIndex++}`);
    bindings.push(queryInput.status);
  }

  const search = queryInput.query?.trim();
  if (search) {
    conditions.push(`(email LIKE ?${bindIndex} OR name LIKE ?${bindIndex} OR id = ?${bindIndex + 1})`);
    bindings.push(`%${search}%`, search);
    bindIndex += 2;
  }

  const whereClause = conditions.join(" AND ");

  const countResult = await c.env.DB
    .prepare(`SELECT COUNT(*) AS total FROM customers WHERE ${whereClause}`)
    .bind(...bindings)
    .all<{ total: number }>();
  const totalItems = Number(countResult.results[0]?.total ?? 0);

  const itemsResult = await c.env.DB
    .prepare(
      `SELECT id, email, name, status, created_at, updated_at
       FROM customers
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT ?${bindIndex++} OFFSET ?${bindIndex++}`
    )
    .bind(...bindings, limit, offset)
    .all();

  return c.json({
    success: true,
    data: {
      items: itemsResult.results,
      pagination: {
        page,
        limit,
        total: totalItems,
        total_pages: Math.ceil(totalItems / limit),
      },
    },
  });
});

adminCustomersRouter.get("/:customerId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const instanceId = c.get("instanceId")!;
  const customerId = c.req.param("customerId");
  const customer = await c.env.DB
    .prepare(
      `SELECT id, email, name, status, created_at, updated_at
       FROM customers WHERE instance_id = ?1 AND id = ?2 LIMIT 1`
    )
    .bind(instanceId, customerId)
    .all();
  if (!customer.results[0]) throw new NotFoundError("Customer not found");
  const licenses = await c.env.DB
    .prepare(
      `SELECT id, product_id, status, license_model, renewal_mode, expires_at, updates_until, created_at
       FROM licenses WHERE instance_id = ?1 AND customer_id = ?2 ORDER BY created_at DESC`
    )
    .bind(instanceId, customerId)
    .all();
  return c.json({ success: true, data: { customer: customer.results[0], licenses: licenses.results } });
});

adminCustomersRouter.patch("/:customerId", ...mutationGuards(), async (c) => {
  const input = UpdateCustomerSchema.parse(await c.req.json());
  const instanceId = c.get("instanceId")!;
  const actorId = c.get("userId")!;
  const customerId = c.req.param("customerId");
  const currentResult = await c.env.DB
    .prepare(`SELECT id, email, name FROM customers WHERE instance_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(instanceId, customerId)
    .all<any>();
  const current = currentResult.results[0];
  if (!current) throw new NotFoundError("Customer not found");
  const email = input.email?.trim().toLowerCase();
  if (email && email !== String(current.email).toLowerCase()) {
    const conflict = await c.env.DB
      .prepare(`SELECT id FROM customers WHERE instance_id = ?1 AND email = ?2 COLLATE NOCASE AND id <> ?3 LIMIT 1`)
      .bind(instanceId, email, customerId)
      .all<{ id: string }>();
    if (conflict.results[0]) throw new ConflictError("CUSTOMER_EMAIL_CONFLICT", "Email belongs to another Customer");
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    c.env.DB
      .prepare(
        `UPDATE customers SET email = COALESCE(?1, email),
             name = CASE WHEN ?2 = 1 THEN ?3 ELSE name END, updated_at = ?4
         WHERE instance_id = ?5 AND id = ?6`
      )
      .bind(email ?? null, input.name !== undefined ? 1 : 0, input.name ?? null, now, instanceId, customerId),
  ];
  if (email && email !== String(current.email).toLowerCase()) {
    statements.push(...revokeCustomerAccessStatements(c.env.DB, instanceId, customerId, now));
  }
  statements.push(
    prepareAuditInsert({
      db: c.env.DB,
      instanceId,
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
    .prepare(`SELECT id, email, name, status, created_at, updated_at FROM customers WHERE instance_id = ?1 AND id = ?2`)
    .bind(instanceId, customerId)
    .all();
  return c.json({ success: true, data: updated.results[0] });
});

function revokeCustomerAccessStatements(
  db: D1Database,
  instanceId: string,
  customerId: string,
  now: string
): D1PreparedStatement[] {
  return [
    db.prepare(
      `UPDATE email_deliveries
       SET send_expires_at = CASE
             WHEN status IN ('accepted', 'cancelled') THEN send_expires_at
             ELSE ?1
           END,
           status = CASE
             WHEN status IN ('accepted', 'cancelled') THEN status
             WHEN status = 'processing' AND locked_until > ?1 THEN status
             ELSE 'expired'
           END,
           variables_ciphertext = CASE
             WHEN status = 'processing' AND locked_until > ?1 THEN variables_ciphertext
             ELSE NULL
           END,
           next_attempt_at = CASE
             WHEN status = 'processing' AND locked_until > ?1 THEN next_attempt_at
             ELSE NULL
           END,
           locked_by = CASE
             WHEN status = 'processing' AND locked_until > ?1 THEN locked_by
             ELSE NULL
           END,
           locked_until = CASE
             WHEN status = 'processing' AND locked_until > ?1 THEN locked_until
             ELSE NULL
           END,
           updated_at = ?1
       WHERE instance_id = ?2
         AND id IN (
           SELECT delivery_id FROM customer_login_challenges
           WHERE instance_id = ?2 AND customer_id = ?3 AND consumed_at IS NULL AND revoked_at IS NULL
         )`
    ).bind(now, instanceId, customerId),
    db.prepare(
      `UPDATE customer_login_challenges SET revoked_at = ?1
       WHERE instance_id = ?2 AND customer_id = ?3 AND consumed_at IS NULL AND revoked_at IS NULL`
    ).bind(now, instanceId, customerId),
    db.prepare(
      `UPDATE customer_sessions SET revoked_at = ?1
       WHERE instance_id = ?2 AND customer_id = ?3 AND revoked_at IS NULL`
    ).bind(now, instanceId, customerId),
  ];
}

async function setCustomerStatus(c: any, status: "active" | "disabled") {
  const instanceId = c.get("instanceId") as string;
  const actorId = c.get("userId") as string;
  const customerId = c.req.param("customerId");
  const exists = await c.env.DB
    .prepare(`SELECT id FROM customers WHERE instance_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(instanceId, customerId)
    .all();
  if (!exists.results[0]) throw new NotFoundError("Customer not found");
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    c.env.DB
      .prepare(`UPDATE customers SET status = ?1, updated_at = ?2 WHERE instance_id = ?3 AND id = ?4`)
      .bind(status, now, instanceId, customerId),
  ];
  if (status === "disabled") statements.push(...revokeCustomerAccessStatements(c.env.DB, instanceId, customerId, now));
  statements.push(
    prepareAuditInsert({
      db: c.env.DB,
      instanceId,
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
  const instanceId = c.get("instanceId")!;
  const actorId = c.get("userId")!;
  const customerId = c.req.param("customerId");
  const exists = await c.env.DB
    .prepare(`SELECT id FROM customers WHERE instance_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(instanceId, customerId)
    .all<{ id: string }>();
  if (!exists.results[0]) throw new NotFoundError("Customer not found");
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE customer_sessions SET revoked_at = ?1
         WHERE instance_id = ?2 AND customer_id = ?3 AND revoked_at IS NULL`
      )
      .bind(now, instanceId, customerId),
    prepareAuditInsert({
      db: c.env.DB,
      instanceId,
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
