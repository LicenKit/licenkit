import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext } from "../../types";
import { bufferToHex } from "../../infra/crypto";
import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../../infra/delivery/crypto";
import { dispatchDelivery } from "../../infra/delivery/dispatcher";
import { requirePublicHttpsUrl } from "../../infra/delivery/url-policy";
import { adminCsrf, requireExactOrigin, requireRole } from "../../middleware/auth";
import { AppError, NotFoundError } from "../../middleware/error";
import { prepareAuditInsert } from "../../services/identity/audit";
import { requestIp } from "../../services/identity/session";
import { prepareEndpointTestDelivery } from "../../services/delivery/outbox";
import { rateLimit } from "../../middleware/rate-limit";

export const adminOutboundRouter = new Hono<AppContext>();
export const adminWebhooksRouter = adminOutboundRouter;

const EndpointSchema = z.object({
  endpointType: z.enum(["notification_gateway", "event_subscriber"]),
  name: z.string().trim().min(1).max(120),
  url: z.string().url(),
  subscribedEvents: z.array(z.string().trim().min(1).max(120)).min(1),
  timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
  maxAutomaticAttempts: z.number().int().min(1).max(20).default(4),
});

const UpdateEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  url: z.string().url().optional(),
  subscribedEvents: z.array(z.string().trim().min(1).max(120)).min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
  maxAutomaticAttempts: z.number().int().min(1).max(20).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

function signingSecret(): string {
  return `lks_${bufferToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function mutationGuards() {
  return [requireExactOrigin, adminCsrf, requireRole(["owner", "admin"])] as const;
}

adminOutboundRouter.get("/endpoints", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const result = await c.env.DB
    .prepare(
      `SELECT id, endpoint_type, name, url, subscribed_events_json,
              timeout_ms, max_automatic_attempts, status, created_at, updated_at
       FROM outbound_endpoints WHERE account_id = ?1 ORDER BY created_at DESC`
    )
    .bind(c.get("accountId")!)
    .all<any>();
  return c.json({
    success: true,
    data: {
      items: result.results.map((row) => ({
        id: row.id,
        endpointType: row.endpoint_type,
        name: row.name,
        url: row.url,
        subscribedEvents: JSON.parse(row.subscribed_events_json),
        timeoutMs: row.timeout_ms,
        maxAutomaticAttempts: row.max_automatic_attempts,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    },
  });
});

adminOutboundRouter.post("/endpoints", ...mutationGuards(), async (c) => {
  const input = EndpointSchema.parse(await c.req.json());
  requirePublicHttpsUrl(input.url);
  const accountId = c.get("accountId")!;
  const actorId = c.get("userId")!;
  const endpointId = `oep_${ulid().toLowerCase()}`;
  const secret = signingSecret();
  const now = new Date().toISOString();
  const ciphertext = await encryptEnvelopeV1(secret, c.env as any, {
    accountId,
    table: "outbound_endpoints",
    rowId: endpointId,
    field: "signing_secret_ciphertext",
  });
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO outbound_endpoints (
           id, account_id, endpoint_type, name, url, signing_secret_ciphertext,
           subscribed_events_json, timeout_ms, max_automatic_attempts,
           status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?10)`
      )
      .bind(
        endpointId,
        accountId,
        input.endpointType,
        input.name,
        input.url,
        ciphertext,
        JSON.stringify([...new Set(input.subscribedEvents)]),
        input.timeoutMs,
        input.maxAutomaticAttempts,
        now
      ),
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: actorId },
      action: "admin.outbound_endpoint.created",
      resourceType: "outbound_endpoint",
      resourceId: endpointId,
      details: { endpointType: input.endpointType, url: input.url, subscribedEvents: input.subscribedEvents },
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
      now,
    }),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: {
      id: endpointId,
      endpointType: input.endpointType,
      name: input.name,
      url: input.url,
      signingSecret: secret,
      subscribedEvents: input.subscribedEvents,
      timeoutMs: input.timeoutMs,
      maxAutomaticAttempts: input.maxAutomaticAttempts,
      status: "active",
    },
  }, 201);
});

adminOutboundRouter.patch("/endpoints/:endpointId", ...mutationGuards(), async (c) => {
  const input = UpdateEndpointSchema.parse(await c.req.json());
  if (input.url) requirePublicHttpsUrl(input.url);
  const accountId = c.get("accountId")!;
  const actorId = c.get("userId")!;
  const endpointId = c.req.param("endpointId");
  const existing = await c.env.DB
    .prepare(`SELECT id FROM outbound_endpoints WHERE account_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(accountId, endpointId)
    .all<{ id: string }>();
  if (!existing.results[0]) throw new NotFoundError("Outbound endpoint not found");
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE outbound_endpoints
         SET name = COALESCE(?1, name), url = COALESCE(?2, url),
             subscribed_events_json = COALESCE(?3, subscribed_events_json),
             timeout_ms = COALESCE(?4, timeout_ms),
             max_automatic_attempts = COALESCE(?5, max_automatic_attempts),
             updated_at = ?6
         WHERE account_id = ?7 AND id = ?8`
      )
      .bind(
        input.name ?? null,
        input.url ?? null,
        input.subscribedEvents ? JSON.stringify([...new Set(input.subscribedEvents)]) : null,
        input.timeoutMs ?? null,
        input.maxAutomaticAttempts ?? null,
        now,
        accountId,
        endpointId
      ),
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: actorId },
      action: "admin.outbound_endpoint.updated",
      resourceType: "outbound_endpoint",
      resourceId: endpointId,
      details: input,
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
      now,
    }),
  ]);
  return c.json({ success: true, data: { id: endpointId, updated: true } });
});

adminOutboundRouter.post("/endpoints/:endpointId/rotate-secret", ...mutationGuards(), async (c) => {
  const accountId = c.get("accountId")!;
  const actorId = c.get("userId")!;
  const endpointId = c.req.param("endpointId");
  const existing = await c.env.DB
    .prepare(`SELECT id FROM outbound_endpoints WHERE account_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(accountId, endpointId)
    .all<{ id: string }>();
  if (!existing.results[0]) throw new NotFoundError("Outbound endpoint not found");
  const secret = signingSecret();
  const ciphertext = await encryptEnvelopeV1(secret, c.env as any, {
    accountId,
    table: "outbound_endpoints",
    rowId: endpointId,
    field: "signing_secret_ciphertext",
  });
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE outbound_endpoints SET signing_secret_ciphertext = ?1, updated_at = ?2
         WHERE account_id = ?3 AND id = ?4`
      )
      .bind(ciphertext, now, accountId, endpointId),
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: actorId },
      action: "admin.outbound_endpoint.secret_rotated",
      resourceType: "outbound_endpoint",
      resourceId: endpointId,
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
      now,
    }),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: { id: endpointId, signingSecret: secret } });
});

adminOutboundRouter.post("/endpoints/:endpointId/disable", ...mutationGuards(), async (c) => {
  const accountId = c.get("accountId")!;
  const actorId = c.get("userId")!;
  const endpointId = c.req.param("endpointId");
  const now = new Date().toISOString();
  const update = c.env.DB
    .prepare(
      `UPDATE outbound_endpoints SET status = 'disabled', updated_at = ?1
       WHERE account_id = ?2 AND id = ?3`
    )
    .bind(now, accountId, endpointId);
  const result = await update.run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new NotFoundError("Outbound endpoint not found");
  await c.env.DB.batch([
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: actorId },
      action: "admin.outbound_endpoint.disabled",
      resourceType: "outbound_endpoint",
      resourceId: endpointId,
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
      now,
    }),
  ]);
  return c.json({ success: true, data: { id: endpointId, status: "disabled" } });
});

adminOutboundRouter.post("/endpoints/:endpointId/test", ...mutationGuards(), rateLimit({
  limit: 10,
  windowSeconds: 300,
  keyPrefix: "admin_endpoint_test",
  key: (c) => `${c.get("accountId")}:${c.get("userId")}:${c.req.param("endpointId")}`,
}), async (c) => {
  const accountId = c.get("accountId")!;
  const actorId = c.get("userId")!;
  const endpointId = c.req.param("endpointId");
  const prepared = await prepareEndpointTestDelivery({
    db: c.env.DB,
    env: c.env as any,
    accountId,
    endpointId,
  });
  await c.env.DB.batch(prepared.statements);
  const result = await dispatchDelivery({
    db: c.env.DB,
    env: c.env as any,
    accountId,
    deliveryId: prepared.deliveryId,
  });
  await c.env.DB.batch([
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: actorId },
      action: "admin.outbound_endpoint.tested",
      resourceType: "outbound_endpoint",
      resourceId: endpointId,
      details: { deliveryId: prepared.deliveryId, status: result.status, errorCode: result.errorCode },
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
    }),
  ]);
  return c.json({ success: true, data: { deliveryId: prepared.deliveryId, ...result } });
});

adminOutboundRouter.get("/deliveries", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const accountId = c.get("accountId")!;
  const status = c.req.query("status");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const query = status
    ? c.env.DB.prepare(
        `SELECT id, endpoint_id, customer_id, license_id, event_type, recipient_email,
                status, attempt_count, automatic_attempt_count, max_automatic_attempts,
                next_attempt_at, last_error_code, last_error_detail, accepted_at,
                payload_expires_at, payload_cleared_at, created_at, updated_at
         FROM outbound_deliveries WHERE account_id = ?1 AND status = ?2
         ORDER BY created_at DESC LIMIT ?3`
      ).bind(accountId, status, limit)
    : c.env.DB.prepare(
        `SELECT id, endpoint_id, customer_id, license_id, event_type, recipient_email,
                status, attempt_count, automatic_attempt_count, max_automatic_attempts,
                next_attempt_at, last_error_code, last_error_detail, accepted_at,
                payload_expires_at, payload_cleared_at, created_at, updated_at
         FROM outbound_deliveries WHERE account_id = ?1
         ORDER BY created_at DESC LIMIT ?2`
      ).bind(accountId, limit);
  const result = await query.all();
  return c.json({ success: true, data: { items: result.results } });
});

adminOutboundRouter.get("/deliveries/:deliveryId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const accountId = c.get("accountId")!;
  const deliveryId = c.req.param("deliveryId");
  const delivery = await c.env.DB
    .prepare(
      `SELECT id, endpoint_id, customer_id, license_id, event_type, recipient_email,
              status, attempt_count, automatic_attempt_count, max_automatic_attempts,
              next_attempt_at, last_error_code, last_error_detail, accepted_at,
              payload_expires_at, payload_cleared_at, created_at, updated_at
       FROM outbound_deliveries WHERE account_id = ?1 AND id = ?2 LIMIT 1`
    )
    .bind(accountId, deliveryId)
    .all();
  if (!delivery.results[0]) throw new NotFoundError("Delivery not found");
  const attempts = await c.env.DB
    .prepare(
      `SELECT id, attempt_number, attempt_source, outcome, http_status,
              response_body_redacted, transport_error_code, transport_error_detail,
              started_at, completed_at, duration_ms
       FROM outbound_attempts WHERE account_id = ?1 AND delivery_id = ?2
       ORDER BY attempt_number`
    )
    .bind(accountId, deliveryId)
    .all();
  return c.json({ success: true, data: { delivery: delivery.results[0], attempts: attempts.results } });
});

adminOutboundRouter.post("/deliveries/:deliveryId/retry", ...mutationGuards(), async (c) => {
  const accountId = c.get("accountId")!;
  const actorId = c.get("userId")!;
  const deliveryId = c.req.param("deliveryId");
  const row = await c.env.DB
    .prepare(
      `SELECT status, payload_ciphertext, payload_expires_at, attempt_count
       FROM outbound_deliveries WHERE account_id = ?1 AND id = ?2 LIMIT 1`
    )
    .bind(accountId, deliveryId)
    .all<any>();
  const delivery = row.results[0];
  if (!delivery) throw new NotFoundError("Delivery not found");
  if (delivery.status !== "failed" || !delivery.payload_ciphertext || delivery.attempt_count < 1) {
    throw new AppError("DELIVERY_NOT_RETRYABLE", "Only failed deliveries with retained payload can be retried", 409);
  }
  if (delivery.payload_expires_at <= new Date().toISOString()) {
    const expiredAt = new Date().toISOString();
    await c.env.DB
      .prepare(
        `UPDATE outbound_deliveries
         SET status = 'payload_expired', payload_ciphertext = NULL,
             payload_cleared_at = ?1, next_attempt_at = NULL, updated_at = ?1
         WHERE account_id = ?2 AND id = ?3 AND payload_ciphertext IS NOT NULL`
      )
      .bind(expiredAt, accountId, deliveryId)
      .run();
    throw new AppError("DELIVERY_PAYLOAD_EXPIRED", "Delivery payload has expired", 409);
  }
  await c.env.DB.batch([
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: actorId },
      action: "admin.outbound_delivery.manual_retry",
      resourceType: "outbound_delivery",
      resourceId: deliveryId,
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
    }),
  ]);
  const result = await dispatchDelivery({
    db: c.env.DB,
    env: c.env as any,
    accountId,
    deliveryId,
    manual: true,
  });
  return c.json({ success: true, data: { deliveryId, ...result } });
});

adminOutboundRouter.post(
  "/deliveries/:deliveryId/resume-after-configuration",
  ...mutationGuards(),
  async (c) => {
    const accountId = c.get("accountId")!;
    const actorId = c.get("userId")!;
    const deliveryId = c.req.param("deliveryId");
    const deliveryResult = await c.env.DB
      .prepare(
        `SELECT id, event_type, status, attempt_count, payload_ciphertext, payload_expires_at
         FROM outbound_deliveries WHERE account_id = ?1 AND id = ?2 LIMIT 1`
      )
      .bind(accountId, deliveryId)
      .all<any>();
    const delivery = deliveryResult.results[0];
    if (!delivery) throw new NotFoundError("Delivery not found");
    if (delivery.status !== "blocked_configuration" || delivery.attempt_count !== 0 || !delivery.payload_ciphertext) {
      throw new AppError("DELIVERY_NOT_RESUMABLE", "Delivery cannot be resumed after configuration", 409);
    }
    const now = new Date().toISOString();
    if (delivery.payload_expires_at <= now) {
      await c.env.DB
        .prepare(
          `UPDATE outbound_deliveries
           SET status = 'payload_expired', payload_ciphertext = NULL,
               payload_cleared_at = ?1, next_attempt_at = NULL, updated_at = ?1
           WHERE account_id = ?2 AND id = ?3 AND payload_ciphertext IS NOT NULL`
        )
        .bind(now, accountId, deliveryId)
        .run();
      throw new AppError("DELIVERY_PAYLOAD_EXPIRED", "Delivery payload has expired", 409);
    }
    const endpointResult = await c.env.DB
      .prepare(
        `SELECT e.id, e.url, e.signing_secret_ciphertext, e.max_automatic_attempts
         FROM outbound_endpoints AS e
         WHERE e.account_id = ?1 AND e.endpoint_type = 'notification_gateway'
           AND e.status = 'active'
           AND EXISTS (SELECT 1 FROM json_each(e.subscribed_events_json) WHERE value = ?2 OR value = '*')
           AND EXISTS (
             SELECT 1 FROM outbound_deliveries AS test
             WHERE test.account_id = e.account_id AND test.endpoint_id = e.id
               AND test.event_type = 'endpoint.test' AND test.status = 'accepted'
               AND test.accepted_at >= e.updated_at
           )
         LIMIT 1`
      )
      .bind(accountId, delivery.event_type)
      .all<any>();
    const endpoint = endpointResult.results[0];
    if (!endpoint) {
      throw new AppError("NOTIFICATION_GATEWAY_NOT_READY", "An active, tested Notification Gateway is required", 409);
    }
    requirePublicHttpsUrl(endpoint.url);
    const secret = await decryptEnvelopeV1(endpoint.signing_secret_ciphertext, c.env as any, {
      accountId,
      table: "outbound_endpoints",
      rowId: endpoint.id,
      field: "signing_secret_ciphertext",
    });
    const secretSnapshot = await encryptEnvelopeV1(secret, c.env as any, {
      accountId,
      table: "outbound_deliveries",
      rowId: deliveryId,
      field: "signing_secret_ciphertext",
    });
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE outbound_deliveries
           SET endpoint_id = ?1, target_url = ?2, signing_secret_ciphertext = ?3,
               max_automatic_attempts = ?4, status = 'pending', next_attempt_at = ?5,
               updated_at = ?5
           WHERE account_id = ?6 AND id = ?7 AND status = 'blocked_configuration'
             AND attempt_count = 0 AND payload_ciphertext IS NOT NULL AND payload_expires_at > ?5`
        )
        .bind(endpoint.id, endpoint.url, secretSnapshot, endpoint.max_automatic_attempts, now, accountId, deliveryId),
      prepareAuditInsert({
        db: c.env.DB,
        accountId,
        actor: { type: "user", id: actorId },
        action: "admin.outbound_delivery.resumed_after_configuration",
        resourceType: "outbound_delivery",
        resourceId: deliveryId,
        details: { endpointId: endpoint.id },
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    return c.json({ success: true, data: { deliveryId, status: "pending" } });
  }
);
