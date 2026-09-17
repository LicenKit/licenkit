import { Hono } from "hono";
import { ulid } from "ulid";
import { eq, and } from "drizzle-orm";
import type { AppContext } from "../types";
import { getTenantDB } from "../infra/db";
import { accounts, webhookEvents, webhookEndpoints, licenses, policies } from "../infra/db/schema";
import { decryptEnvelope } from "../infra/crypto";
import { AppError, NotFoundError } from "../middleware/error";

export const webhookRouter = new Hono<AppContext>();

// POST /api/v1/webhooks/:provider/:account_id
webhookRouter.post("/:provider/:account_id", async (c) => {
  const provider = c.req.param("provider").toLowerCase();
  const accountId = c.req.param("account_id");
  const rawBody = await c.req.text();

  if (!["stripe", "paddle", "lemonsqueezy", "custom"].includes(provider)) {
    throw new AppError("INVALID_PROVIDER", "Unsupported payment provider", 400);
  }

  const db = getTenantDB(c, accountId);

  // 1. Fetch account and payment config
  const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account || !account.isActive) {
    throw new NotFoundError("Account not found or inactive");
  }

  // Decrypt payment config to get webhook secret
  let webhookSecret = "";
  if (account.paymentConfigs && c.env.STORAGE_ENCRYPTION_KEY) {
    try {
      const decrypted = await decryptEnvelope(account.paymentConfigs, c.env.STORAGE_ENCRYPTION_KEY);
      const parsed = JSON.parse(decrypted);
      webhookSecret = parsed[provider]?.webhook_secret || "";
    } catch (e) {
      console.error("Failed to decrypt webhook secret", e);
    }
  }

  // Parse webhook payload
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new AppError("INVALID_JSON", "Payload is not valid JSON", 400);
  }

  // Extract external event_id and event_type
  let externalEventId = payload.id || payload.event_id || payload.alert_id || null;
  let eventType = payload.type || payload.event_type || payload.alert_name || "unknown";

  // Check idempotency for inbound events
  if (externalEventId) {
    const existing = await db
      .select({ id: webhookEvents.id, status: webhookEvents.status })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.accountId, accountId),
          eq(webhookEvents.provider, provider),
          eq(webhookEvents.eventId, externalEventId)
        )
      )
      .get();

    if (existing && existing.status === "processed") {
      // Return 200 immediately for idempotent duplicate
      return c.json({ success: true, message: "Duplicate event already processed" }, 200);
    }
  }

  const inboundEventId = `evt_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();

  // Record inbound event
  await db.insert(webhookEvents).values({
    id: inboundEventId,
    accountId,
    provider,
    direction: "inbound",
    eventId: externalEventId,
    eventType,
    payload: rawBody,
    status: "processed",
    attempts: 1,
    createdAt: now,
    processedAt: now,
  });

  // Query outbound endpoints matching tenant and push notifications to EVENT_QUEUE
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.accountId, accountId), eq(webhookEndpoints.isActive, true)))
    .all();

  if (endpoints.length > 0 && c.env.EVENT_QUEUE) {
    for (const ep of endpoints) {
      const outboundId = `evt_${ulid().toLowerCase()}`;
      await db.insert(webhookEvents).values({
        id: outboundId,
        accountId,
        provider: "internal",
        direction: "outbound",
        endpointId: ep.id,
        eventType,
        payload: rawBody,
        status: "pending",
        attempts: 0,
        createdAt: now,
      });

      // Send to Cloudflare Queue
      await c.env.EVENT_QUEUE.send({
        eventId: outboundId,
        endpointId: ep.id,
        url: ep.url,
        secret: ep.secret,
        payload: rawBody,
      });
    }
  }

  return c.json({
    success: true,
    data: {
      received: true,
      event_id: inboundEventId,
    },
  });
});
