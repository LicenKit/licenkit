import { sha256Hex, verifyHmacSha256 } from "../crypto";
import { decryptEnvelopeV1 } from "../delivery/crypto";
import { BillingProcessingError, PaddleHttpError } from "./errors";
import type {
  BillingEnvironment,
  BillingProviderRecord,
  PaddleEventReferences,
  PaddleLineItem,
  PaddleWebhookEnvelope,
  ProviderHttpErrorDetails,
} from "./types";

const PADDLE_ID = /^(ctm|txn|sub|adj|pri)_[A-Za-z0-9]+$/;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function assertPaddleClientToken(environment: BillingEnvironment, token: string): void {
  const expected = environment === "sandbox" ? "test_" : "live_";
  if (!token.startsWith(expected) || token.length > 512) {
    throw new BillingProcessingError(
      "BILLING_PROVIDER_CLIENT_TOKEN_ENVIRONMENT_MISMATCH",
      `Paddle ${environment} client-side token must start with ${expected}.`,
      "failed",
      { provider: "paddle", environment, expectedPrefix: expected },
    );
  }
}

export async function verifyPaddleWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(";").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("ts="))?.slice(3);
  const signatures = parts
    .filter((part) => part.startsWith("h1="))
    .map((part) => part.slice(3))
    .filter(Boolean);
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  if (Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) > toleranceSeconds) return false;

  const signedPayload = `${timestamp}:${rawBody}`;
  for (const signature of signatures) {
    if (await verifyHmacSha256(signedPayload, secret, signature)) return true;
  }
  return false;
}

export function parsePaddleWebhook(rawBody: string): PaddleWebhookEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new BillingProcessingError("BILLING_WEBHOOK_INVALID_JSON", "Paddle payload is not valid JSON.", "failed");
  }
  const root = asObject(parsed);
  const eventId = stringOrNull(root.event_id);
  const eventType = stringOrNull(root.event_type);
  const occurredAt = stringOrNull(root.occurred_at);
  const data = asObject(root.data);
  if (!eventId || !eventType || !occurredAt || Object.keys(data).length === 0) {
    throw new BillingProcessingError(
      "BILLING_WEBHOOK_CONTRACT_INVALID",
      "Paddle payload is missing event_id, event_type, occurred_at, or data.",
      "failed",
      { provider: "paddle", externalEventId: eventId, providerEventType: eventType },
    );
  }
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new BillingProcessingError(
      "BILLING_WEBHOOK_OCCURRED_AT_INVALID",
      "Paddle occurred_at is not a valid timestamp.",
      "failed",
      { provider: "paddle", externalEventId: eventId, occurredAt },
    );
  }
  return { event_id: eventId, event_type: eventType, occurred_at: occurredAt, data };
}

export function extractPaddleReferences(event: PaddleWebhookEnvelope): PaddleEventReferences {
  const data = event.data;
  const isCustomerEvent = event.event_type === "customer.created" || event.event_type === "customer.updated";
  const isTransactionEvent = event.event_type.startsWith("transaction.");
  const isSubscriptionEvent = event.event_type.startsWith("subscription.");
  const isAdjustmentEvent = event.event_type.startsWith("adjustment.");

  return {
    externalCustomerId: isCustomerEvent
      ? stringOrNull(data.id)
      : stringOrNull(data.customer_id),
    externalTransactionId: isTransactionEvent
      ? stringOrNull(data.id)
      : stringOrNull(data.transaction_id),
    externalSubscriptionId: isSubscriptionEvent
      ? stringOrNull(data.id)
      : stringOrNull(data.subscription_id),
    externalAdjustmentId: isAdjustmentEvent ? stringOrNull(data.id) : null,
  };
}

export function extractPaddleLineItems(data: Record<string, unknown>): PaddleLineItem[] {
  const direct = Array.isArray(data.items) ? data.items : [];
  const details = asObject(data.details);
  const source = direct.length > 0
    ? direct
    : Array.isArray(details.line_items)
      ? details.line_items
      : [];

  return source.map((raw) => {
    const item = asObject(raw);
    const price = asObject(item.price);
    const priceId = stringOrNull(price.id) ?? stringOrNull(item.price_id);
    const quantity = typeof item.quantity === "number" ? item.quantity : Number(item.quantity ?? 0);
    if (!priceId || !PADDLE_ID.test(priceId) || !Number.isInteger(quantity) || quantity < 1) {
      throw new BillingProcessingError(
        "BILLING_TRANSACTION_LINE_ITEM_INVALID",
        "Paddle transaction contains an invalid Price or quantity.",
        "needs_attention",
        { provider: "paddle", externalPriceId: priceId, quantity: item.quantity ?? null },
      );
    }
    return { priceId, quantity };
  });
}

export function getPaddleCustomData(data: Record<string, unknown>): Record<string, unknown> {
  return asObject(data.custom_data);
}

function paddleApiBase(environment: BillingEnvironment): string {
  return environment === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
}

async function parsePaddleHttpError(response: Response, operation: string): Promise<ProviderHttpErrorDetails> {
  let body: Record<string, unknown> = {};
  try {
    body = asObject(await response.json());
  } catch {
    body = {};
  }
  const error = asObject(body.error);
  const meta = asObject(body.meta);
  return {
    provider: "paddle",
    operation,
    httpStatus: response.status,
    providerCode: stringOrNull(error.code),
    requestId: response.headers.get("request-id") ?? stringOrNull(meta.request_id),
    retryAfter: response.headers.get("retry-after"),
    message: stringOrNull(error.detail) ?? stringOrNull(error.message) ?? `Paddle returned HTTP ${response.status}.`,
  };
}

export interface TrustedPaddleCustomer {
  id: string;
  email: string;
  name: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string | null;
  requestId: string | null;
}

export interface PaddleCustomerPortalSession {
  url: string;
  expiresAt: string;
  requestId: string | null;
}

export async function fetchPaddleCustomer(
  provider: BillingProviderRecord,
  externalCustomerId: string,
  env: { STORAGE_ENCRYPTION_KEY?: string; STORAGE_ENCRYPTION_KEY_ID?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TrustedPaddleCustomer> {
  if (!/^ctm_[A-Za-z0-9]+$/.test(externalCustomerId)) {
    throw new BillingProcessingError(
      "BILLING_CUSTOMER_ID_INVALID",
      "Paddle Customer ID has an invalid format.",
      "needs_attention",
      { provider: "paddle", externalCustomerId },
    );
  }
  if (!provider.api_secret_ciphertext) {
    throw new BillingProcessingError(
      "BILLING_CUSTOMER_PENDING",
      "Paddle Customer mapping is not available yet; waiting for a Customer webhook.",
      "retry",
      { provider: "paddle", externalCustomerId, apiReadThroughConfigured: false },
    );
  }

  const apiKey = await decryptEnvelopeV1(provider.api_secret_ciphertext, env, {
    accountId: provider.account_id,
    table: "billing_providers",
    rowId: provider.id,
    field: "api_secret_ciphertext",
  });
  let response: Response;
  try {
    response = await fetchImpl(`${paddleApiBase(provider.environment)}/customers/${encodeURIComponent(externalCustomerId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Paddle-Version": "1" },
    });
  } catch (error) {
    const detail: ProviderHttpErrorDetails = {
      provider: "paddle",
      operation: "customers.get",
      httpStatus: null,
      providerCode: null,
      requestId: null,
      retryAfter: null,
      message: error instanceof Error ? error.message : "Paddle customer request failed.",
    };
    throw new PaddleHttpError("BILLING_PROVIDER_TRANSPORT_ERROR", detail.message, "retry", detail);
  }
  if (!response.ok) {
    const detail = await parsePaddleHttpError(response, "customers.get");
    const disposition = response.status === 404 ? "needs_attention" : "retry";
    const code = response.status === 404
      ? "BILLING_CUSTOMER_NOT_FOUND"
      : response.status === 401 || response.status === 403
        ? "BILLING_PROVIDER_API_AUTH_INVALID"
        : "BILLING_PROVIDER_API_ERROR";
    throw new PaddleHttpError(code, detail.message, disposition, detail);
  }
  const body = asObject(await response.json());
  const data = asObject(body.data);
  const id = stringOrNull(data.id);
  const email = stringOrNull(data.email);
  const status = stringOrNull(data.status);
  const createdAt = stringOrNull(data.created_at);
  const updatedAt = stringOrNull(data.updated_at);
  if (id !== externalCustomerId || !email || !createdAt || (status !== "active" && status !== "archived")) {
    throw new BillingProcessingError(
      "BILLING_PROVIDER_RESPONSE_INVALID",
      "Paddle customer response did not match the requested Customer contract.",
      "needs_attention",
      { provider: "paddle", externalCustomerId, responseCustomerId: id, providerStatus: status },
    );
  }
  const meta = asObject(body.meta);
  return {
    id,
    email,
    name: stringOrNull(data.name),
    status,
    createdAt,
    updatedAt,
    requestId: response.headers.get("request-id") ?? stringOrNull(meta.request_id),
  };
}

/**
 * Creates one short-lived Paddle-hosted portal session. The operation does not
 * mutate LicenKit or Paddle subscription facts; callers decide whether the URL
 * is returned to the requesting Customer or discarded as a capability probe.
 */
export async function createPaddleCustomerPortalSession(
  provider: BillingProviderRecord,
  externalCustomerId: string,
  externalSubscriptionId: string,
  env: { STORAGE_ENCRYPTION_KEY?: string; STORAGE_ENCRYPTION_KEY_ID?: string },
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<PaddleCustomerPortalSession> {
  if (!/^ctm_[A-Za-z0-9]+$/.test(externalCustomerId) || !/^sub_[A-Za-z0-9]+$/.test(externalSubscriptionId)) {
    throw new BillingProcessingError(
      "BILLING_CUSTOMER_PORTAL_REFERENCE_INVALID",
      "Paddle Customer or Subscription ID has an invalid format.",
      "needs_attention",
      { provider: "paddle", externalCustomerId, externalSubscriptionId },
    );
  }
  if (!provider.api_secret_ciphertext) {
    throw new BillingProcessingError(
      "BILLING_CUSTOMER_PORTAL_NOT_CONFIGURED",
      "Paddle customer portal capability is not configured for this Provider.",
      "failed",
      { billingProviderId: provider.id, capability: "customer_portal_session" },
    );
  }
  const apiKey = await decryptEnvelopeV1(provider.api_secret_ciphertext, env, {
    accountId: provider.account_id,
    table: "billing_providers",
    rowId: provider.id,
    field: "api_secret_ciphertext",
  });
  let response: Response;
  try {
    response = await fetchImpl(
      `${paddleApiBase(provider.environment)}/customers/${encodeURIComponent(externalCustomerId)}/portal-sessions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Paddle-Version": "1",
        },
        body: JSON.stringify({ subscription_ids: [externalSubscriptionId] }),
      },
    );
  } catch (error) {
    const detail: ProviderHttpErrorDetails = {
      provider: "paddle",
      operation: "customer_portal_sessions.create",
      httpStatus: null,
      providerCode: null,
      requestId: null,
      retryAfter: null,
      message: error instanceof Error ? error.message : "Paddle customer portal request failed.",
    };
    throw new PaddleHttpError("BILLING_PROVIDER_TRANSPORT_ERROR", detail.message, "retry", detail);
  }
  if (!response.ok) {
    const detail = await parsePaddleHttpError(response, "customer_portal_sessions.create");
    const code = response.status === 401 || response.status === 403
      ? "BILLING_PROVIDER_API_AUTH_INVALID"
      : "BILLING_CUSTOMER_PORTAL_PROVIDER_ERROR";
    throw new PaddleHttpError(code, detail.message, "retry", detail);
  }
  let body: Record<string, unknown>;
  try {
    body = asObject(await response.json());
  } catch {
    body = {};
  }
  const data = asObject(body.data);
  const urls = asObject(data.urls);
  const general = asObject(urls.general);
  const url = stringOrNull(general.overview);
  if (!url || !url.startsWith("https://")) {
    throw new BillingProcessingError(
      "BILLING_CUSTOMER_PORTAL_RESPONSE_INVALID",
      "Paddle did not return a valid hosted customer portal URL.",
      "needs_attention",
      { provider: "paddle", billingProviderId: provider.id, requestId: response.headers.get("request-id") },
    );
  }
  const expiresAtValue = stringOrNull(data.expires_at);
  const expiresAt = expiresAtValue && Number.isFinite(Date.parse(expiresAtValue))
    ? new Date(expiresAtValue).toISOString()
    : new Date(now.getTime() + 15 * 60_000).toISOString();
  const meta = asObject(body.meta);
  return {
    url,
    expiresAt,
    requestId: response.headers.get("request-id") ?? stringOrNull(meta.request_id),
  };
}

/**
 * Verifies only the configured Paddle customer.read capability. A successful
 * list request does not prove that the connection owns any Customer referenced
 * by a previously blocked event; each event still resolves its own Customer ID
 * through fetchPaddleCustomer when it re-enters the fulfillment state machine.
 */
export async function probePaddleCustomerRead(
  provider: BillingProviderRecord,
  env: { STORAGE_ENCRYPTION_KEY?: string; STORAGE_ENCRYPTION_KEY_ID?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ requestId: string | null }> {
  if (!provider.api_secret_ciphertext) {
    throw new BillingProcessingError(
      "BILLING_PROVIDER_API_CAPABILITY_DISABLED",
      "Paddle customer.read is not configured for this Provider.",
      "failed",
      { provider: "paddle", billingProviderId: provider.id, capability: "customer_read" },
    );
  }
  const apiKey = await decryptEnvelopeV1(provider.api_secret_ciphertext, env, {
    accountId: provider.account_id,
    table: "billing_providers",
    rowId: provider.id,
    field: "api_secret_ciphertext",
  });
  let response: Response;
  try {
    response = await fetchImpl(`${paddleApiBase(provider.environment)}/customers?per_page=1`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Paddle-Version": "1" },
    });
  } catch (error) {
    const detail: ProviderHttpErrorDetails = {
      provider: "paddle",
      operation: "customers.list",
      httpStatus: null,
      providerCode: null,
      requestId: null,
      retryAfter: null,
      message: error instanceof Error ? error.message : "Paddle customer capability probe failed.",
    };
    throw new PaddleHttpError("BILLING_PROVIDER_TRANSPORT_ERROR", detail.message, "retry", detail);
  }
  if (!response.ok) {
    const detail = await parsePaddleHttpError(response, "customers.list");
    const code = response.status === 401 || response.status === 403
      ? "BILLING_PROVIDER_API_AUTH_INVALID"
      : "BILLING_PROVIDER_API_ERROR";
    throw new PaddleHttpError(code, detail.message, "retry", detail);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const data = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).data
    : null;
  if (!Array.isArray(data)) {
    throw new BillingProcessingError(
      "BILLING_PROVIDER_RESPONSE_INVALID",
      "Paddle customer.read probe returned an invalid response.",
      "needs_attention",
      {
        provider: "paddle",
        billingProviderId: provider.id,
        capability: "customer_read",
        operation: "customers.list",
        requestId: response.headers.get("request-id"),
      },
    );
  }
  const meta = body && typeof body === "object" && !Array.isArray(body)
    ? asObject((body as Record<string, unknown>).meta)
    : {};
  return { requestId: response.headers.get("request-id") ?? stringOrNull(meta.request_id) };
}

export async function hashPaddlePayload(rawBody: string): Promise<string> {
  return sha256Hex(rawBody);
}
