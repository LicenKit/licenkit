import { Hono } from "hono";
import { ulid } from "ulid";
import type { AppContext } from "../types";
import { AppError, NotFoundError } from "../middleware/error";
import {
  extractPaddleReferences,
  hashPaddlePayload,
  parsePaddleWebhook,
  verifyPaddleWebhookSignature,
} from "../infra/billing/paddle";
import { decryptBillingProviderWebhookSecret, encryptInboundPayload } from "../infra/billing/storage";
import type { BillingProviderRecord } from "../infra/billing/types";
import { BillingProcessingError } from "../infra/billing/errors";
import { processBillingInboundEvent } from "../services/billing/fulfillment";

export const webhookRouter = new Hono<AppContext>();

function inboundPayloadTtlSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 86_400;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(
      "BILLING_INBOUND_PAYLOAD_TTL_INVALID",
      "SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS must be a positive integer.",
      500,
    );
  }
  return parsed;
}

/**
 * Paddle receipt boundary. This route verifies the raw request and durably
 * records one immutable Inbound Event. After that durable boundary it invokes
 * the same processor used by the Scheduled Worker; the HTTP response never
 * waits for fulfillment to finish.
 */
webhookRouter.post("/payments/:accountSlug/:billingProviderId", async (c) => {
  const accountSlug = c.req.param("accountSlug");
  const billingProviderId = c.req.param("billingProviderId");
  const route = await c.env.DB.prepare(
    `SELECT provider.id, provider.account_id, provider.provider, provider.environment,
            provider.client_side_token, provider.webhook_secret_ciphertext,
            provider.api_secret_ciphertext, provider.status,
            provider.created_at, provider.updated_at
     FROM billing_providers AS provider
     JOIN accounts AS account ON account.id = provider.account_id
     WHERE account.slug = ?1
       AND account.status = 'active'
       AND provider.account_id = account.id
       AND provider.id = ?2
       AND provider.provider = 'paddle'
       AND provider.status = 'active'
     LIMIT 1`,
  ).bind(accountSlug, billingProviderId).first<BillingProviderRecord>();
  if (!route) throw new NotFoundError("Paddle webhook destination was not found.");

  const rawBody = await c.req.text();
  const signatureHeader = c.req.header("paddle-signature");
  if (!rawBody || !signatureHeader) {
    throw new AppError(
      "BILLING_WEBHOOK_SIGNATURE_OR_BODY_MISSING",
      "Paddle-Signature and a raw request body are required.",
      400,
      { provider: "paddle", billingProviderId },
    );
  }

  const webhookSecret = await decryptBillingProviderWebhookSecret(route, c.env);
  if (!await verifyPaddleWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    throw new AppError(
      "BILLING_WEBHOOK_SIGNATURE_INVALID",
      "Paddle webhook signature verification failed.",
      401,
      { provider: "paddle", billingProviderId },
    );
  }

  let event;
  try {
    event = parsePaddleWebhook(rawBody);
  } catch (error) {
    if (error instanceof BillingProcessingError) {
      throw new AppError(error.code, error.message, 400, error.details);
    }
    throw error;
  }
  if (event.event_id.length > 255 || event.event_type.length > 255) {
    throw new AppError(
      "BILLING_WEBHOOK_IDENTIFIER_TOO_LONG",
      "Paddle event ID or event type exceeds the accepted length.",
      400,
      { provider: "paddle", externalEventIdLength: event.event_id.length, eventTypeLength: event.event_type.length },
    );
  }

  const references = extractPaddleReferences(event);
  const inboundEventId = `ine_${ulid().toLowerCase()}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const payloadExpiresAt = new Date(
    now.getTime() + inboundPayloadTtlSeconds(c.env.SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS) * 1000,
  ).toISOString();
  const payloadCiphertext = await encryptInboundPayload(
    rawBody,
    c.env,
    route.account_id,
    inboundEventId,
  );
  const payloadHash = await hashPaddlePayload(rawBody);

  await c.env.DB.prepare(
    `INSERT INTO inbound_events (
       id, account_id, billing_provider_id, external_event_id, external_event_type,
       external_customer_id, external_transaction_id, external_subscription_id,
       external_adjustment_id, external_occurred_at, payload_ciphertext,
       payload_hash, payload_expires_at, status, attempt_count, next_attempt_at,
       received_at, updated_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
       'pending', 0, ?14, ?14, ?14
     )
     ON CONFLICT(billing_provider_id, external_event_id) DO NOTHING`,
  ).bind(
    inboundEventId,
    route.account_id,
    route.id,
    event.event_id,
    event.event_type,
    references.externalCustomerId,
    references.externalTransactionId,
    references.externalSubscriptionId,
    references.externalAdjustmentId,
    event.occurred_at,
    payloadCiphertext,
    payloadHash,
    payloadExpiresAt,
    nowIso,
  ).run();

  const persisted = await c.env.DB.prepare(
    `SELECT id, status, received_at
     FROM inbound_events
     WHERE account_id = ?1 AND billing_provider_id = ?2 AND external_event_id = ?3
     LIMIT 1`,
  ).bind(route.account_id, route.id, event.event_id).first<{
    id: string; status: string; received_at: string;
  }>();
  if (!persisted) {
    throw new AppError(
      "BILLING_WEBHOOK_PERSISTENCE_FAILED",
      "Paddle event was verified but could not be persisted.",
      500,
      { provider: "paddle", externalEventId: event.event_id, billingProviderId: route.id },
    );
  }

  let executionContext: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    executionContext = c.executionCtx;
  } catch (error) {
    if (c.env.ENVIRONMENT === "production") {
      throw new AppError(
        "BILLING_WEBHOOK_EXECUTION_CONTEXT_MISSING",
        "Paddle event was persisted, but its immediate background processor could not be registered.",
        500,
        { provider: "paddle", externalEventId: event.event_id, billingProviderId: route.id },
        { contextError: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  if (executionContext) {
    executionContext.waitUntil(processBillingInboundEvent({
      env: c.env,
      accountId: route.account_id,
      eventId: persisted.id,
      workerId: `billing_http_${ulid().toLowerCase()}`,
    }).then(() => undefined));
  } else if (c.env.ENVIRONMENT === "production") {
    throw new AppError(
      "BILLING_WEBHOOK_EXECUTION_CONTEXT_MISSING",
      "Paddle event was persisted, but its immediate background processor could not be registered.",
      500,
      { provider: "paddle", externalEventId: event.event_id, billingProviderId: route.id },
    );
  }

  return c.json({
    success: true,
    data: {
      received: true,
      eventId: persisted.id,
      externalEventId: event.event_id,
      status: persisted.status,
      duplicate: persisted.id !== inboundEventId,
    },
  }, 200);
});
