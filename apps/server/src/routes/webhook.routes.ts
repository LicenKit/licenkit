import { Hono, type Context } from "hono";
import { ulid } from "ulid";
import type { AppContext } from "../types";
import { AppError, NotFoundError } from "../middleware/error";
import {
  extractPaddleReferences,
  hashPaddlePayload,
  parsePaddleWebhook,
  verifyPaddleWebhookSignature,
} from "../infra/billing/paddle";
import {
  decryptBillingProviderWebhookSecret,
  encryptInboundPayload,
} from "../infra/billing/storage";
import { PADDLE_SUPPORTED_EVENT_TYPES, type BillingProviderRecord } from "../infra/billing/types";
import { BillingProcessingError } from "../infra/billing/errors";
import { processBillingInboundEvent } from "../services/billing/fulfillment";

export const webhookRouter = new Hono<AppContext>();

async function recordRejectedPaddleWebhook(
  c: Context<AppContext>,
  route: BillingProviderRecord,
  errorCode: string,
  httpStatus: 400 | 401,
  rawBody: string,
): Promise<void> {
  const requestId = c.get("requestId");
  try {
    await c.env.DB.prepare(
      `INSERT INTO webhook_rejections (
         id, instance_id, billing_provider_id, request_id, error_code,
         http_status, webhook_secret_version, payload_hash, received_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      `whr_${ulid().toLowerCase()}`,
      route.instance_id,
      route.id,
      requestId,
      errorCode,
      httpStatus,
      route.webhook_secret_version,
      rawBody ? await hashPaddlePayload(rawBody) : null,
      new Date().toISOString(),
    ).run();
  } catch (error) {
    throw new AppError(
      "BILLING_WEBHOOK_REJECTION_RECORD_FAILED",
      "The rejected Paddle request could not be recorded.",
      500,
      { provider: "paddle", billing_provider_id: route.id, original_error_code: errorCode },
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

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

async function verifyAndParsePaddleWebhook(
  c: Context<AppContext>,
  route: BillingProviderRecord,
) {
  const rawBody = await c.req.text();
  const signatureHeader = c.req.header("paddle-signature");
  if (!rawBody || !signatureHeader) {
    await recordRejectedPaddleWebhook(c, route, "BILLING_WEBHOOK_SIGNATURE_OR_BODY_MISSING", 400, rawBody);
    throw new AppError(
      "BILLING_WEBHOOK_SIGNATURE_OR_BODY_MISSING",
      "Paddle-Signature and a raw request body are required.",
      400,
      { provider: "paddle", billing_provider_id: route.id },
    );
  }

  let webhookSecret: string;
  try {
    webhookSecret = await decryptBillingProviderWebhookSecret(route, c.env);
  } catch (error) {
    throw error;
  }
  if (!await verifyPaddleWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    await recordRejectedPaddleWebhook(c, route, "BILLING_WEBHOOK_SIGNATURE_INVALID", 401, rawBody);
    throw new AppError(
      "BILLING_WEBHOOK_SIGNATURE_INVALID",
      "Paddle webhook signature verification failed.",
      401,
      { provider: "paddle", billing_provider_id: route.id },
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
      {
        provider: "paddle",
        external_event_id_length: event.event_id.length,
        event_type_length: event.event_type.length,
      },
    );
  }
  // Paddle assigns distinct event ID namespaces to real and simulated events.
  // The ID is part of the signed raw body; an unknown namespace must not enter fulfillment.
  const source = event.event_id.startsWith("ntfsimevt_")
    ? "simulation"
    : event.event_id.startsWith("evt_")
      ? "platform"
      : null;
  if (!source) {
    throw new AppError(
      "BILLING_WEBHOOK_SOURCE_UNKNOWN",
      "Paddle webhook event ID does not identify a platform or simulation event.",
      422,
      { provider: "paddle", billing_provider_id: route.id, external_event_id: event.event_id },
    );
  }
  return { rawBody, event, source, payloadHash: await hashPaddlePayload(rawBody) };
}

type VerifiedPaddleWebhook = Awaited<ReturnType<typeof verifyAndParsePaddleWebhook>>;

async function receivePaddleWebhook(c: Context<AppContext>, route: BillingProviderRecord, verified: VerifiedPaddleWebhook) {
  const { rawBody, event, payloadHash } = verified;

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
    route.instance_id,
    inboundEventId,
  );
  await c.env.DB.prepare(
    `INSERT INTO inbound_events (
       id, instance_id, billing_provider_id, webhook_secret_version,
       external_event_id, external_event_type,
       external_customer_id, external_transaction_id, external_subscription_id,
       external_adjustment_id, external_occurred_at, payload_ciphertext,
       payload_hash, payload_expires_at, status, attempt_count, next_attempt_at,
       received_at, updated_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
       'pending', 0, ?15, ?15, ?15
     )
     ON CONFLICT(instance_id, billing_provider_id, external_event_id) DO NOTHING`,
  ).bind(
    inboundEventId,
    route.instance_id,
    route.id,
    route.webhook_secret_version,
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
    `SELECT id, status, payload_ciphertext, payload_hash, payload_expires_at,
            webhook_secret_version, received_at
     FROM inbound_events
     WHERE instance_id = ?1 AND billing_provider_id = ?2 AND external_event_id = ?3
     LIMIT 1`,
  ).bind(route.instance_id, route.id, event.event_id).first<{
    id: string;
    status: string;
    payload_ciphertext: string | null;
    payload_hash: string;
    payload_expires_at: string;
    webhook_secret_version: number | null;
    received_at: string;
  }>();
  if (!persisted) {
    throw new AppError(
      "BILLING_WEBHOOK_PERSISTENCE_FAILED",
      "Paddle event was verified but could not be persisted.",
      500,
      { provider: "paddle", external_event_id: event.event_id, billing_provider_id: route.id },
    );
  }
  const duplicate = persisted.id !== inboundEventId;
  if (persisted.payload_hash !== payloadHash) {
    throw new AppError(
      "BILLING_WEBHOOK_EVENT_ID_CONFLICT",
      "Paddle event ID was already persisted with a different payload.",
      409,
      { provider: "paddle", external_event_id: event.event_id, billing_provider_id: route.id },
    );
  }

  if (
    duplicate
    && (persisted.webhook_secret_version === null
      || persisted.webhook_secret_version < route.webhook_secret_version)
  ) {
    await c.env.DB.prepare(
      `UPDATE inbound_events
       SET webhook_secret_version = ?1
       WHERE instance_id = ?2 AND id = ?3 AND payload_hash = ?4
         AND (webhook_secret_version IS NULL OR webhook_secret_version < ?1)`,
    ).bind(
      route.webhook_secret_version,
      route.instance_id,
      persisted.id,
      payloadHash,
    ).run();
  }

  let payloadRefreshed = false;
  if (
    duplicate
    && ["pending", "failed", "needs_attention"].includes(persisted.status)
    && (!persisted.payload_ciphertext || Date.parse(persisted.payload_expires_at) <= now.getTime())
  ) {
    const refreshedCiphertext = await encryptInboundPayload(
      rawBody,
      c.env,
      route.instance_id,
      persisted.id,
    );
    const refresh = await c.env.DB.prepare(
      `UPDATE inbound_events
       SET payload_ciphertext = ?1, payload_expires_at = ?2,
           payload_cleared_at = NULL, updated_at = ?3
       WHERE instance_id = ?4 AND id = ?5 AND payload_hash = ?6
         AND status IN ('pending', 'failed', 'needs_attention')
         AND (payload_ciphertext IS NULL OR payload_expires_at <= ?3)`,
    ).bind(
      refreshedCiphertext,
      payloadExpiresAt,
      nowIso,
      route.instance_id,
      persisted.id,
      payloadHash,
    ).run();
    payloadRefreshed = Number(refresh.meta?.changes ?? 0) === 1;
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
        { provider: "paddle", external_event_id: event.event_id, billing_provider_id: route.id },
        { context_error: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  if (executionContext) {
    executionContext.waitUntil(processBillingInboundEvent({
      env: c.env,
      instanceId: route.instance_id,
      eventId: persisted.id,
      workerId: `billing_http_${ulid().toLowerCase()}`,
    }).then(() => undefined));
  } else if (c.env.ENVIRONMENT === "production") {
    throw new AppError(
      "BILLING_WEBHOOK_EXECUTION_CONTEXT_MISSING",
      "Paddle event was persisted, but its immediate background processor could not be registered.",
      500,
      { provider: "paddle", external_event_id: event.event_id, billing_provider_id: route.id },
    );
  }

  return c.json({
    success: true,
    data: {
      received: true,
      event_id: persisted.id,
      external_event_id: event.event_id,
      status: persisted.status,
      duplicate,
      payload_refreshed: payloadRefreshed,
    },
  }, 200);
}

async function receivePaddleSimulatorWebhook(c: Context<AppContext>, route: BillingProviderRecord, verified: VerifiedPaddleWebhook) {
  const { event, payloadHash } = verified;
  const supported = (PADDLE_SUPPORTED_EVENT_TYPES as readonly string[]).includes(event.event_type);
  const now = new Date().toISOString();
  if (supported) {
    await c.env.DB.prepare(
      `INSERT INTO billing_webhook_simulation_tests (
         id, instance_id, billing_provider_id, event_type,
         simulator_webhook_secret_version, external_event_id, payload_hash,
         verified_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)
       ON CONFLICT(instance_id, billing_provider_id, event_type) DO UPDATE SET
         simulator_webhook_secret_version = excluded.simulator_webhook_secret_version,
         external_event_id = excluded.external_event_id,
         payload_hash = excluded.payload_hash,
         verified_at = excluded.verified_at,
         updated_at = excluded.updated_at`,
    ).bind(
      `bwt_${ulid().toLowerCase()}`,
      route.instance_id,
      route.id,
      event.event_type,
      route.simulator_webhook_secret_version,
      event.event_id,
      payloadHash,
      now,
    ).run();
  }
  return c.json({
    success: true,
    data: {
      received: true,
      traffic_source: "simulation",
      external_event_id: event.event_id,
      event_type: event.event_type,
      counted_for_verification: supported,
    },
  }, 200);
}

async function findPaddleProviderByEnvironment(
  c: Context<AppContext>,
  instanceId: string,
  environment: "sandbox" | "live",
): Promise<BillingProviderRecord | null> {
  return c.env.DB.prepare(
     `SELECT provider.id, provider.instance_id, provider.provider, provider.environment,
            provider.client_side_token, provider.webhook_secret_ciphertext,
            provider.webhook_secret_version, provider.simulator_webhook_secret_ciphertext,
            provider.simulator_webhook_secret_version, provider.api_secret_ciphertext, provider.status,
            provider.created_at, provider.updated_at
     FROM billing_providers AS provider
     JOIN instances AS instance ON instance.id = provider.instance_id
     WHERE instance.id = ?1
       AND instance.status = 'active'
       AND provider.instance_id = instance.id
       AND provider.provider = 'paddle'
       AND provider.environment = ?2
       AND provider.status = 'active'
     LIMIT 1`,
  ).bind(instanceId, environment).first<BillingProviderRecord>();
}

/**
 * Paddle receipt boundary. This route resolves one active Paddle connection,
 * verifies the raw request, and durably records one immutable Inbound Event. The
 * environment route is stable before a connection is created and maps to the
 * single Paddle connection allowed for that Instance and environment.
 */
webhookRouter.post("/payments/:instanceId/paddle/:environment", async (c) => {
  const environment = c.req.param("environment");
  if (environment !== "sandbox" && environment !== "live") {
    throw new NotFoundError("Paddle webhook destination was not found.");
  }
  const route = await findPaddleProviderByEnvironment(c, c.req.param("instanceId"), environment);
  if (!route) throw new NotFoundError("Paddle webhook destination was not found.");
  const verified = await verifyAndParsePaddleWebhook(c, route);
  return verified.source === "simulation"
    ? receivePaddleSimulatorWebhook(c, route, verified)
    : receivePaddleWebhook(c, route, verified);
});
