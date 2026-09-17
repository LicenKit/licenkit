import type { LicenKitDB } from "../infra/db";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../infra/db/schema";
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { computeOutboundWebhookSignature } from "../infra/crypto";

export interface WebhookMessage {
  eventId: string;
  endpointId: string;
  url: string;
  secret: string;
  payload: string;
}

export async function handleQueueBatch(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
  const db = drizzle(env.DB, { schema });

  for (const msg of batch.messages) {
    const { eventId, url, secret, payload } = msg.body;
    const now = new Date().toISOString();

    try {
      // Calculate HMAC signature with anti-replay timestamp header
      const { signatureHeader } = await computeOutboundWebhookSignature(payload, secret);

      // Dispatch HTTP POST to developer's endpoint
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-LicenKit-Signature": signatureHeader,
          "User-Agent": "LicenKit-Webhook-Dispatcher/1.0",
        },
        body: payload,
      });

      if (!response.ok) {
        throw new Error(`Endpoint returned HTTP ${response.status}: ${response.statusText}`);
      }

      // Mark event as processed
      await db
        .update(schema.webhookEvents)
        .set({
          status: "processed",
          attempts: 1,
          processedAt: new Date().toISOString(),
        })
        .where(eq(schema.webhookEvents.id, eventId));

      msg.ack();
    } catch (err: any) {
      console.error(`Failed to deliver webhook event ${eventId} to ${url}:`, err);

      await db
        .update(schema.webhookEvents)
        .set({
          status: "failed",
          lastError: err.message || "Failed delivery",
        })
        .where(eq(schema.webhookEvents.id, eventId));

      // Retry message if attempts < 3
      if (msg.attempts < 3) {
        msg.retry();
      } else {
        msg.ack();
      }
    }
  }
}
