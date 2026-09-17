import { ulid } from "ulid";
import { eq, and } from "drizzle-orm";
import type { Env } from "../../types";
import { webhookEndpoints, webhookEvents } from "../db/schema";

export interface OutboundEventPayload {
  id: string;
  accountId: string;
  event: string;
  createdAt: string;
  data: Record<string, any>;
}

/**
 * Broadcasts a business event asynchronously via Cloudflare EVENT_QUEUE.
 * Automatically checks active webhook_endpoints registered by the tenant,
 * matches product ID and event subscriptions, writes an outbound record into
 * webhook_events, and pushes the payload to the queue.
 */
export async function broadcastOutboundEvent(
  env: Env,
  db: any,
  accountId: string,
  eventType: string,
  data: Record<string, any>,
  productId?: string | null
): Promise<void> {
  if (!env.EVENT_QUEUE) {
    return;
  }

  try {
    const endpoints = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.accountId, accountId), eq(webhookEndpoints.isActive, true)))
      .all();

    if (!endpoints || endpoints.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const eventId = `evt_${ulid().toLowerCase()}`;

    const eventPayload: OutboundEventPayload = {
      id: eventId,
      accountId,
      event: eventType,
      createdAt: now,
      data,
    };

    const payloadJson = JSON.stringify(eventPayload);

    for (const ep of endpoints) {
      // Product filtering: if endpoint is restricted to a specific product and it doesn't match, skip
      if (ep.productId && ep.productId !== "*" && productId && ep.productId !== productId) {
        continue;
      }

      // Event filtering: check if wildcard '*' or specific event is subscribed
      let subscribed: string[] = ["*"];
      try {
        subscribed = JSON.parse(ep.events);
      } catch {
        subscribed = ["*"];
      }

      if (!subscribed.includes("*") && !subscribed.includes(eventType)) {
        continue;
      }

      const outboundRecordId = `evt_${ulid().toLowerCase()}`;

      // 1. Record outbound delivery state
      await db.insert(webhookEvents).values({
        id: outboundRecordId,
        accountId,
        provider: "internal",
        direction: "outbound",
        endpointId: ep.id,
        eventType,
        payload: payloadJson,
        status: "pending",
        attempts: 0,
        createdAt: now,
      });

      // 2. Push message to Cloudflare EVENT_QUEUE
      await env.EVENT_QUEUE.send({
        eventId: outboundRecordId,
        endpointId: ep.id,
        url: ep.url,
        secret: ep.secret,
        payload: payloadJson,
      });
    }
  } catch (err) {
    console.error("Failed to broadcast outbound event:", err);
  }
}
