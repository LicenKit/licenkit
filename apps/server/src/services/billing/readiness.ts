import { PADDLE_REQUIRED_EVENT_TYPES } from "../../infra/billing/types";
import type {
  BillingProviderRecord,
  CheckoutReadiness,
  ReadinessCheck,
} from "../../infra/billing/types";
import { assertPaddleClientToken } from "../../infra/billing/paddle";
import { readSchedulerHealth } from "../runtime/scheduler-health";

export interface BillingOfferReadinessRow {
  id: string;
  account_id: string;
  external_price_id: string;
  product_id: string;
  license_plan_id: string;
  purchase_type: "one_time" | "subscription";
  offer_status: "draft" | "active" | "archived";
  product_status: "active" | "archived";
  billing_environment: "sandbox" | "live" | null;
  license_model: "perpetual" | "fixed_term" | "subscription";
  credential_mode: "opaque" | "signed";
  plan_status: "active" | "archived";
  provider_id: string;
  provider_status: "active" | "disabled";
  provider_environment: "sandbox" | "live";
  client_side_token: string;
  provider_updated_at: string;
}

function check(key: string, ready: boolean, reasonCode?: string, details?: Record<string, unknown>): ReadinessCheck {
  return { key, status: ready ? "ready" : "not_ready", ...(ready ? {} : { reasonCode }), ...(details ? { details } : {}) };
}

export async function getBillingOfferReadinessRow(
  db: D1Database,
  accountId: string,
  offerId: string,
): Promise<BillingOfferReadinessRow | null> {
  const row = await db.prepare(
    `SELECT
       offer.id, offer.account_id, offer.external_price_id, offer.product_id,
       offer.license_plan_id, offer.purchase_type, offer.status AS offer_status,
       product.status AS product_status, product.billing_environment,
       plan.license_model, plan.credential_mode, plan.status AS plan_status,
       provider.id AS provider_id, provider.status AS provider_status,
       provider.environment AS provider_environment,
       provider.client_side_token, provider.updated_at AS provider_updated_at
     FROM billing_offers AS offer
     JOIN products AS product
       ON product.account_id = offer.account_id AND product.id = offer.product_id
     JOIN license_plans AS plan
       ON plan.account_id = offer.account_id
      AND plan.product_id = offer.product_id
      AND plan.id = offer.license_plan_id
     JOIN billing_providers AS provider
       ON provider.account_id = offer.account_id AND provider.id = offer.billing_provider_id
     WHERE offer.account_id = ?1 AND offer.id = ?2
     LIMIT 1`,
  ).bind(accountId, offerId).first<BillingOfferReadinessRow>();
  return row ?? null;
}

async function getReceivedRequiredEventTypes(
  db: D1Database,
  accountId: string,
  providerId: string,
  after: string,
): Promise<Set<string>> {
  const placeholders = PADDLE_REQUIRED_EVENT_TYPES.map((_, index) => `?${index + 4}`).join(", ");
  const result = await db.prepare(
    `SELECT DISTINCT external_event_type
     FROM inbound_events
     WHERE account_id = ?1
       AND billing_provider_id = ?2
       AND received_at >= ?3
       AND external_event_type IN (${placeholders})`,
  ).bind(accountId, providerId, after, ...PADDLE_REQUIRED_EVENT_TYPES).all<{ external_event_type: string }>();
  return new Set(result.results.map((row) => row.external_event_type));
}

async function notificationGatewayReady(db: D1Database, accountId: string): Promise<{ ready: boolean; endpointId?: string }> {
  const row = await db.prepare(
    `SELECT endpoint.id
     FROM outbound_endpoints AS endpoint
     WHERE endpoint.account_id = ?1
       AND endpoint.endpoint_type = 'notification_gateway'
       AND endpoint.status = 'active'
       AND EXISTS (
         SELECT 1 FROM outbound_deliveries AS delivery
         WHERE delivery.account_id = endpoint.account_id
           AND delivery.endpoint_id = endpoint.id
           AND delivery.event_type = 'endpoint.test'
           AND delivery.status = 'accepted'
           AND delivery.accepted_at IS NOT NULL
           AND delivery.created_at >= endpoint.updated_at
       )
     LIMIT 1`,
  ).bind(accountId).first<{ id: string }>();
  return row ? { ready: true, endpointId: row.id } : { ready: false };
}

async function processingBacklogHealthy(db: D1Database, accountId: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
  const row = await db.prepare(
    `SELECT 1 AS unavailable
     FROM inbound_events
     WHERE account_id = ?1
       AND (
         (status = 'pending' AND COALESCE(next_attempt_at, received_at) < ?2)
         OR (status = 'processing' AND locked_until < ?3)
       )
     LIMIT 1`,
  ).bind(accountId, staleBefore, now.toISOString()).first<{ unavailable: number }>();
  return !row;
}

async function checkoutVerificationReady(
  db: D1Database,
  row: BillingOfferReadinessRow,
): Promise<boolean> {
  const match = await db.prepare(
    `SELECT verification.id
     FROM billing_checkout_verifications AS verification
     JOIN billing_offers AS evidence_offer
       ON evidence_offer.account_id = verification.account_id
      AND evidence_offer.id = verification.billing_offer_id
     JOIN billing_providers AS evidence_provider
       ON evidence_provider.account_id = evidence_offer.account_id
      AND evidence_provider.id = evidence_offer.billing_provider_id
     WHERE verification.account_id = ?1
       AND verification.status = 'completed'
       AND evidence_offer.product_id = ?2
       AND evidence_offer.license_plan_id = ?3
       AND evidence_offer.purchase_type = ?4
       AND evidence_provider.environment = 'sandbox'
     ORDER BY verification.completed_at DESC
     LIMIT 1`,
  ).bind(row.account_id, row.product_id, row.license_plan_id, row.purchase_type)
    .first<{ id: string }>();
  return Boolean(match);
}

export async function evaluateBillingOfferReadiness(
  db: D1Database,
  row: BillingOfferReadinessRow,
  options: { now?: Date; activation?: boolean } = {},
): Promise<CheckoutReadiness> {
  const now = options.now ?? new Date();
  const checks: ReadinessCheck[] = [];
  checks.push(check("product", row.product_status === "active", "PRODUCT_UNAVAILABLE"));
  checks.push(check("license_plan", row.plan_status === "active", "CHECKOUT_CONFIGURATION_PENDING"));
  checks.push(check("provider", row.provider_status === "active", "CHECKOUT_PROVIDER_UNAVAILABLE"));
  checks.push(check(
    "environment_binding",
    row.billing_environment !== null && row.billing_environment === row.provider_environment,
    row.billing_environment === null
      ? "PRODUCT_BILLING_ENVIRONMENT_NOT_CONFIGURED"
      : "CHECKOUT_PROVIDER_UNAVAILABLE",
    { productEnvironment: row.billing_environment, providerEnvironment: row.provider_environment },
  ));
  const typeMatches = row.purchase_type === "subscription"
    ? row.license_model === "subscription"
    : row.license_model === "perpetual" || row.license_model === "fixed_term";
  checks.push(check("purchase_type", typeMatches, "CHECKOUT_CONFIGURATION_PENDING"));

  let tokenReady = true;
  try {
    assertPaddleClientToken(row.provider_environment, row.client_side_token);
  } catch {
    tokenReady = false;
  }
  checks.push(check("client_side_token", tokenReady, "CHECKOUT_PROVIDER_UNAVAILABLE"));

  const received = await getReceivedRequiredEventTypes(
    db,
    row.account_id,
    row.provider_id,
    row.provider_updated_at,
  );
  const missingEvents = PADDLE_REQUIRED_EVENT_TYPES.filter((eventType) => !received.has(eventType));
  checks.push(check(
    "webhook_event_contract",
    missingEvents.length === 0,
    "CHECKOUT_CONFIGURATION_PENDING",
    { missingEventTypes: missingEvents },
  ));

  const gateway = await notificationGatewayReady(db, row.account_id);
  checks.push(check("notification_gateway", gateway.ready, "CHECKOUT_NOTIFICATION_UNAVAILABLE"));

  const processingReady = await processingBacklogHealthy(db, row.account_id, now);
  checks.push(check("processing_backlog", processingReady, "CHECKOUT_PROCESSING_UNAVAILABLE"));
  const schedulerHealth = await readSchedulerHealth(db, now);
  checks.push(check(
    "scheduled_worker_health",
    schedulerHealth.ready,
    "CHECKOUT_PROCESSING_UNAVAILABLE",
    schedulerHealth.record
      ? { completedAt: schedulerHealth.record.completedAt, durationMs: schedulerHealth.record.durationMs }
      : { evidence: "not_recorded" },
  ));

  let signingKeyReady = true;
  if (row.credential_mode === "signed") {
    const key = await db.prepare(
      `SELECT id FROM signing_keys
       WHERE account_id = ?1 AND product_id = ?2 AND status = 'active'
       LIMIT 1`,
    ).bind(row.account_id, row.product_id).first<{ id: string }>();
    signingKeyReady = Boolean(key);
  }
  checks.push(check("signing_key", signingKeyReady, "CHECKOUT_CONFIGURATION_PENDING"));

  const verificationReady = await checkoutVerificationReady(db, row);
  checks.push(check("sandbox_end_to_end_verification", verificationReady, "CHECKOUT_CONFIGURATION_PENDING"));

  // The public Client-side Token is intentionally not used as a server API key.
  // Until a management-SDK PricePreview result has a documented persistence
  // field, Live activation remains fail-closed rather than inventing evidence.
  const livePricePreviewReady = row.provider_environment === "sandbox";
  checks.push(check(
    "live_price_preview",
    livePricePreviewReady,
    "CHECKOUT_CONFIGURATION_PENDING",
    row.provider_environment === "live"
      ? { evidence: "not_recorded", verificationPath: "management_checkout_sdk" }
      : { required: false },
  ));

  if (!options.activation) {
    checks.push(check("offer_status", row.offer_status === "active", "NO_ACTIVE_OFFER"));
  }

  const publicReasonCodes = [...new Set(
    checks.filter((item) => item.status !== "ready" && item.reasonCode).map((item) => item.reasonCode!),
  )];
  return { ready: publicReasonCodes.length === 0, publicReasonCodes, checks };
}

export function toProviderRecord(row: BillingOfferReadinessRow): BillingProviderRecord {
  return {
    id: row.provider_id,
    account_id: row.account_id,
    provider: "paddle",
    environment: row.provider_environment,
    client_side_token: row.client_side_token,
    webhook_secret_ciphertext: "",
    api_secret_ciphertext: null,
    status: row.provider_status,
    created_at: row.provider_updated_at,
    updated_at: row.provider_updated_at,
  };
}
