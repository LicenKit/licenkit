import { ulid } from "ulid";
import { licenseEmailNotificationType } from "../../domain/email/contracts";
import { generateLicenseKey, hashLicenseKey, sha256Hex } from "../../infra/crypto";
import { BillingProcessingError, PaddleHttpError } from "../../infra/billing/errors";
import {
  extractPaddleLineItems,
  fetchPaddleCustomer,
  getPaddleCustomData,
  parsePaddleWebhook,
} from "../../infra/billing/paddle";
import { decryptInboundPayload } from "../../infra/billing/storage";
import type { BillingProviderRecord, PaddleWebhookEnvelope } from "../../infra/billing/types";
import { serializeBillingDiagnostic } from "../../infra/billing/redaction";
import {
  getBillingCustomerByExternalId,
  getBillingProvider,
  syncTrustedBillingCustomer,
} from "./customer-sync";
import { prepareEmailNotificationDelivery } from "../delivery/outbox";
import { dispatchDelivery } from "../../infra/delivery/dispatcher";
import { prepareLicenseAudit } from "../license/audit";
import {
  recordInboundEventProviderAuthIssue,
} from "./system-issues";
import { prepareSystemIssueUpsert } from "../operations/system-issues";

export interface BillingWorkerEnv {
  DB: D1Database;
  STORAGE_ENCRYPTION_KEY?: string;
  STORAGE_ENCRYPTION_KEY_ID?: string;
  SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS?: string;
}

interface InboundEventRow {
  id: string;
  instance_id: string;
  billing_provider_id: string;
  external_event_id: string;
  external_event_type: string;
  external_customer_id: string | null;
  external_transaction_id: string | null;
  external_subscription_id: string | null;
  external_adjustment_id: string | null;
  external_occurred_at: string | null;
  payload_ciphertext: string | null;
  payload_expires_at: string;
  status: string;
  attempt_count: number;
  locked_by: string | null;
  received_at: string;
}

interface LicensePlanOfferRow {
  offer_id: string;
  offer_status: "draft" | "active" | "archived";
  external_price_id: string;
  purchase_type: "one_time" | "subscription";
  product_id: string;
  product_name: string;
  product_status: "active" | "archived";
  plan_id: string;
  plan_revision: number;
  license_model: "perpetual" | "fixed_term" | "subscription";
  credential_mode: "opaque" | "signed";
  default_term_seconds: number | null;
  update_window_seconds: number | null;
  offline_grace_seconds: number;
  payment_grace_seconds: number;
  max_activations: number;
  features_json: string;
  plan_status: "active" | "archived";
  provider_environment: "sandbox" | "live";
}

interface ExistingSubscriptionRow {
  id: string;
  license_id: string;
  external_subscription_id: string;
  external_customer_id: string;
  status: "trialing" | "active" | "past_due" | "paused" | "canceled";
  last_external_occurred_at: string | null;
  is_checkout_verification: number;
  license_status: "active" | "suspended" | "revoked";
  status_reason: string | null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseExternalInstant(value: unknown, field: string): string | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) {
    throw new BillingProcessingError(
      "BILLING_PROVIDER_TIMESTAMP_INVALID",
      `Paddle ${field} is not a valid timestamp.`,
      "needs_attention",
      { provider: "paddle", field, value: text },
    );
  }
  return date.toISOString();
}

function subscriptionPeriod(data: Record<string, unknown>): { start: string | null; end: string | null } {
  const period = asObject(data.current_billing_period);
  return {
    start: parseExternalInstant(period.starts_at, "current_billing_period.starts_at"),
    end: parseExternalInstant(period.ends_at, "current_billing_period.ends_at"),
  };
}

function transactionPeriod(data: Record<string, unknown>): { start: string | null; end: string | null } {
  const period = asObject(data.billing_period);
  return {
    start: parseExternalInstant(period.starts_at, "billing_period.starts_at"),
    end: parseExternalInstant(period.ends_at, "billing_period.ends_at"),
  };
}

function assertSubscriptionStatus(value: unknown): ExistingSubscriptionRow["status"] {
  if (value === "trialing" || value === "active" || value === "past_due" || value === "paused" || value === "canceled") {
    return value;
  }
  throw new BillingProcessingError(
    "BILLING_SUBSCRIPTION_STATUS_UNSUPPORTED",
    "Paddle Subscription status is not supported by the V1 state machine.",
    "needs_attention",
    { provider: "paddle", providerStatus: value ?? null },
  );
}

function processingResultStatement(
  db: D1Database,
  event: InboundEventRow,
  workerId: string,
  resultType: string,
  resultReferenceId: string | null,
  nowIso: string,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE inbound_events
     SET status = 'processed', result_type = ?1, result_reference_id = ?2,
         last_error_code = NULL, last_error_detail = NULL,
         next_attempt_at = NULL, locked_by = NULL, locked_until = NULL,
         processed_at = ?3, updated_at = ?3
     WHERE instance_id = ?4 AND id = ?5 AND status = 'processing' AND locked_by = ?6`,
  ).bind(resultType, resultReferenceId, nowIso, event.instance_id, event.id, workerId);
}

async function markProcessed(
  db: D1Database,
  event: InboundEventRow,
  workerId: string,
  resultType: string,
  resultReferenceId: string | null,
  nowIso: string,
): Promise<void> {
  await processingResultStatement(db, event, workerId, resultType, resultReferenceId, nowIso).run();
}

async function loadEventPayload(
  env: BillingWorkerEnv,
  event: InboundEventRow,
  now = new Date(),
): Promise<PaddleWebhookEnvelope> {
  if (!event.payload_ciphertext || Date.parse(event.payload_expires_at) <= now.getTime()) {
    throw new BillingProcessingError(
      "BILLING_EVENT_PAYLOAD_EXPIRED",
      "The encrypted Paddle event payload is no longer available for processing.",
      "needs_attention",
      { provider: "paddle", externalEventId: event.external_event_id, inboundEventId: event.id },
    );
  }
  const raw = await decryptInboundPayload(
    event.payload_ciphertext,
    env,
    event.instance_id,
    event.id,
  );
  const parsed = parsePaddleWebhook(raw);
  if (parsed.event_id !== event.external_event_id || parsed.event_type !== event.external_event_type) {
    throw new BillingProcessingError(
      "BILLING_EVENT_PAYLOAD_IDENTITY_MISMATCH",
      "Stored Paddle event identity does not match its encrypted payload.",
      "failed",
      {
        inboundEventId: event.id,
        storedExternalEventId: event.external_event_id,
        payloadExternalEventId: parsed.event_id,
        storedEventType: event.external_event_type,
        payloadEventType: parsed.event_type,
      },
    );
  }
  return parsed;
}

async function loadCorrelatedEvent(
  env: BillingWorkerEnv,
  event: InboundEventRow,
  type: string,
  referenceColumn: "external_transaction_id" | "external_subscription_id",
  referenceValue: string,
): Promise<{ row: InboundEventRow; payload: PaddleWebhookEnvelope } | null> {
  const row = await env.DB.prepare(
    `SELECT id, instance_id, billing_provider_id, external_event_id, external_event_type,
            external_customer_id, external_transaction_id, external_subscription_id,
            external_adjustment_id, external_occurred_at, payload_ciphertext,
            payload_expires_at, status,
            attempt_count, locked_by, received_at
     FROM inbound_events
     WHERE instance_id = ?1 AND billing_provider_id = ?2
       AND external_event_type = ?3 AND ${referenceColumn} = ?4
     ORDER BY received_at DESC
     LIMIT 1`,
  ).bind(event.instance_id, event.billing_provider_id, type, referenceValue).first<InboundEventRow>();
  if (!row) return null;
  return { row, payload: await loadEventPayload(env, row) };
}

async function processCustomerEvent(
  env: BillingWorkerEnv,
  event: InboundEventRow,
  payload: PaddleWebhookEnvelope,
  workerId: string,
  now: Date,
): Promise<void> {
  const data = payload.data;
  const externalCustomerId = stringOrNull(data.id);
  const email = stringOrNull(data.email);
  const status = stringOrNull(data.status);
  const createdAt = parseExternalInstant(data.created_at, "customer.created_at");
  const updatedAt = parseExternalInstant(data.updated_at, "customer.updated_at");
  if (!externalCustomerId || !email || !createdAt || (status !== "active" && status !== "archived")) {
    throw new BillingProcessingError(
      "BILLING_CUSTOMER_EVENT_INVALID",
      "Paddle Customer event is missing required identity fields.",
      "needs_attention",
      { provider: "paddle", externalEventId: payload.event_id, externalCustomerId, providerStatus: status },
    );
  }
  const result = await syncTrustedBillingCustomer({
    db: env.DB,
    instanceId: event.instance_id,
    billingProviderId: event.billing_provider_id,
    source: "webhook",
    now,
    snapshot: {
      externalCustomerId,
      email,
      name: stringOrNull(data.name),
      status,
      externalUpdatedAt: updatedAt ?? createdAt,
      externalEventId: payload.event_id,
    },
  });
  const nowIso = now.toISOString();
  await processingResultStatement(
    env.DB,
    event,
    workerId,
    result.ignoredAsStale ? "ignored_as_stale" : "billing_customer_synced",
    result.id,
    nowIso,
  ).run();
}

async function resolveCustomerForNewPurchase(
  env: BillingWorkerEnv,
  event: InboundEventRow,
  provider: BillingProviderRecord,
  externalCustomerId: string | null,
  now: Date,
): Promise<{ billingCustomerId: string; customerId: string; email: string }> {
  if (!externalCustomerId) {
    throw new BillingProcessingError(
      "BILLING_TRANSACTION_CUSTOMER_MISSING",
      "Paddle purchase event does not identify a Customer.",
      "needs_attention",
      { provider: "paddle", externalEventId: event.external_event_id },
    );
  }
  let mapping = await getBillingCustomerByExternalId(
    env.DB,
    event.instance_id,
    event.billing_provider_id,
    externalCustomerId,
  );
  if (!mapping) {
    try {
      const customer = await fetchPaddleCustomer(provider, externalCustomerId, env);
      mapping = await syncTrustedBillingCustomer({
        db: env.DB,
        instanceId: event.instance_id,
        billingProviderId: event.billing_provider_id,
        source: "api",
        now,
        snapshot: {
          externalCustomerId: customer.id,
          email: customer.email,
          name: customer.name,
          status: customer.status,
          externalUpdatedAt: customer.updatedAt ?? customer.createdAt,
          externalEventId: event.external_event_id,
        },
      });
    } catch (error) {
      // Shared credential/permission failures must stay visible as the exact
      // Provider capability failure even when this event has waited longer
      // than the normal Customer dependency window.
      if (error instanceof PaddleHttpError && error.code === "BILLING_PROVIDER_API_AUTH_INVALID") {
        throw error;
      }
      if (error instanceof BillingProcessingError && error.disposition === "retry") {
        const waitingMs = now.getTime() - Date.parse(event.received_at);
        if (waitingMs >= 24 * 60 * 60_000) {
          throw new BillingProcessingError(
            "BILLING_CUSTOMER_PENDING_TIMEOUT",
            "Paddle Customer mapping did not arrive before the configured waiting limit.",
            "needs_attention",
            {
              provider: "paddle",
              externalCustomerId,
              inboundEventId: event.id,
              lastDependencyError: error.code,
              details: error.details,
            },
          );
        }
      }
      throw error;
    }
  }
  if (!mapping || mapping.provider_status !== "active" || mapping.link_status !== "linked" || !mapping.customer_id) {
    const disposition = mapping?.link_status === "email_mismatch" || mapping?.provider_status === "archived"
      ? "needs_attention"
      : "retry";
    throw new BillingProcessingError(
      mapping?.link_status === "email_mismatch" ? "BILLING_CUSTOMER_EMAIL_MISMATCH" : "BILLING_CUSTOMER_PENDING",
      "Paddle Customer is not safely linked to a LicenKit Customer.",
      disposition,
      {
        provider: "paddle",
        externalCustomerId,
        billingCustomerId: mapping?.id ?? null,
        linkStatus: mapping?.link_status ?? "missing",
        providerStatus: mapping?.provider_status ?? null,
      },
    );
  }
  const customer = await env.DB.prepare(
    `SELECT email, status FROM customers
     WHERE instance_id = ?1 AND id = ?2
     LIMIT 1`,
  ).bind(event.instance_id, mapping.customer_id).first<{ email: string; status: string }>();
  if (!customer || customer.status !== "active") {
    throw new BillingProcessingError(
      "BILLING_CUSTOMER_DISABLED",
      "The linked LicenKit Customer is not active.",
      "needs_attention",
      { billingCustomerId: mapping.id, customerId: mapping.customer_id },
    );
  }
  return { billingCustomerId: mapping.id, customerId: mapping.customer_id, email: customer.email };
}

async function getExistingSubscription(
  db: D1Database,
  instanceId: string,
  providerId: string,
  externalSubscriptionId: string,
): Promise<ExistingSubscriptionRow | null> {
  const row = await db.prepare(
    `SELECT subscription.id, subscription.license_id, subscription.external_subscription_id,
            subscription.external_customer_id, subscription.status,
            subscription.last_external_occurred_at, license.is_checkout_verification,
            license.status AS license_status, license.status_reason
     FROM billing_subscriptions AS subscription
     JOIN licenses AS license
       ON license.instance_id = subscription.instance_id AND license.id = subscription.license_id
     WHERE subscription.instance_id = ?1
       AND subscription.billing_provider_id = ?2
       AND subscription.external_subscription_id = ?3
     LIMIT 1`,
  ).bind(instanceId, providerId, externalSubscriptionId).first<ExistingSubscriptionRow>();
  return row ?? null;
}

async function lookupOffer(
  db: D1Database,
  instanceId: string,
  providerId: string,
  externalPriceId: string,
  status: "active" | "draft",
): Promise<LicensePlanOfferRow | null> {
  const row = await db.prepare(
    `SELECT offer.id AS offer_id, offer.status AS offer_status, offer.external_price_id,
            offer.purchase_type, product.id AS product_id, product.name AS product_name,
            product.status AS product_status,
            plan.id AS plan_id, plan.revision AS plan_revision, plan.license_model,
            plan.credential_mode, plan.default_term_seconds, plan.update_window_seconds,
            plan.offline_grace_seconds, plan.payment_grace_seconds,
            plan.max_activations, plan.features_json, plan.status AS plan_status,
            provider.environment AS provider_environment
     FROM billing_offers AS offer
     JOIN products AS product
       ON product.instance_id = offer.instance_id AND product.id = offer.product_id
     JOIN license_plans AS plan
       ON plan.instance_id = offer.instance_id
      AND plan.product_id = offer.product_id
      AND plan.id = offer.license_plan_id
     JOIN billing_providers AS provider
       ON provider.instance_id = offer.instance_id AND provider.id = offer.billing_provider_id
     WHERE offer.instance_id = ?1 AND offer.billing_provider_id = ?2
       AND offer.external_price_id = ?3 AND offer.status = ?4
     LIMIT 1`,
  ).bind(instanceId, providerId, externalPriceId, status).first<LicensePlanOfferRow>();
  return row ?? null;
}

function assertOfferCanFulfill(
  offer: LicensePlanOfferRow,
  expectedPurchaseType: "one_time" | "subscription",
): void {
  if (offer.product_status !== "active" || offer.plan_status !== "active") {
    throw new BillingProcessingError(
      "BILLING_OFFER_TARGET_UNAVAILABLE",
      "The mapped Product or License Plan is archived.",
      "needs_attention",
      { offerId: offer.offer_id, productStatus: offer.product_status, planStatus: offer.plan_status },
    );
  }
  if (offer.purchase_type !== expectedPurchaseType) {
    throw new BillingProcessingError(
      "BILLING_OFFER_PURCHASE_TYPE_MISMATCH",
      "Paddle purchase type does not match the Offer mapping.",
      "needs_attention",
      { offerId: offer.offer_id, offerPurchaseType: offer.purchase_type, purchaseType: expectedPurchaseType },
    );
  }
  const modelMatches = expectedPurchaseType === "subscription"
    ? offer.license_model === "subscription"
    : offer.license_model === "perpetual" || offer.license_model === "fixed_term";
  if (!modelMatches) {
    throw new BillingProcessingError(
      "BILLING_OFFER_LICENSE_MODEL_MISMATCH",
      "Offer purchase type does not match the mapped License Plan.",
      "needs_attention",
      { offerId: offer.offer_id, purchaseType: expectedPurchaseType, licenseModel: offer.license_model },
    );
  }
}

async function resolveOfferAndVerification(input: {
  env: BillingWorkerEnv;
  event: InboundEventRow;
  payload: PaddleWebhookEnvelope;
  priceId: string;
  purchaseType: "one_time" | "subscription";
  now: Date;
}): Promise<{ offer: LicensePlanOfferRow; verificationId: string | null }> {
  const customData = getPaddleCustomData(input.payload.data);
  const verificationToken = stringOrNull(customData.licenkit_checkout_verification);
  if (!verificationToken) {
    const offer = await lookupOffer(
      input.env.DB,
      input.event.instance_id,
      input.event.billing_provider_id,
      input.priceId,
      "active",
    );
    if (!offer) {
      throw new BillingProcessingError(
        "BILLING_OFFER_MAPPING_MISSING",
        "No active Offer matches the Paddle Price.",
        "needs_attention",
        {
          provider: "paddle",
          externalEventId: input.event.external_event_id,
          externalTransactionId: input.event.external_transaction_id,
          externalPriceId: input.priceId,
        },
      );
    }
    assertOfferCanFulfill(offer, input.purchaseType);
    return { offer, verificationId: null };
  }

  const tokenHash = await sha256Hex(verificationToken);
  const verification = await input.env.DB.prepare(
    `SELECT verification.id, verification.status, verification.expires_at,
            offer.id AS offer_id
     FROM billing_checkout_verifications AS verification
     JOIN billing_offers AS offer
       ON offer.instance_id = verification.instance_id
      AND offer.id = verification.billing_offer_id
     JOIN billing_providers AS provider
       ON provider.instance_id = offer.instance_id
      AND provider.id = offer.billing_provider_id
     WHERE verification.instance_id = ?1
       AND verification.token_hash = ?2
       AND offer.billing_provider_id = ?3
       AND offer.external_price_id = ?4
       AND offer.status = 'draft'
       AND provider.environment = 'sandbox'
     LIMIT 1`,
  ).bind(
    input.event.instance_id,
    tokenHash,
    input.event.billing_provider_id,
    input.priceId,
  ).first<{ id: string; status: string; expires_at: string; offer_id: string }>();
  if (!verification || verification.status !== "pending" || Date.parse(verification.expires_at) <= input.now.getTime()) {
    throw new BillingProcessingError(
      "BILLING_CHECKOUT_VERIFICATION_INVALID",
      "Checkout verification token is invalid, expired, consumed, or does not match this Sandbox Offer.",
      "needs_attention",
      {
        provider: "paddle",
        externalEventId: input.event.external_event_id,
        externalTransactionId: input.event.external_transaction_id,
        externalPriceId: input.priceId,
        verificationStatus: verification?.status ?? "not_found",
      },
    );
  }
  const offer = await lookupOffer(
    input.env.DB,
    input.event.instance_id,
    input.event.billing_provider_id,
    input.priceId,
    "draft",
  );
  if (!offer || offer.offer_id !== verification.offer_id) {
    throw new BillingProcessingError(
      "BILLING_CHECKOUT_VERIFICATION_OFFER_MISMATCH",
      "Checkout verification does not identify the current draft Offer.",
      "needs_attention",
      { verificationId: verification.id, externalPriceId: input.priceId },
    );
  }
  assertOfferCanFulfill(offer, input.purchaseType);
  return { offer, verificationId: verification.id };
}

interface SubscriptionFacts {
  externalSubscriptionId: string;
  status: ExistingSubscriptionRow["status"];
  periodStart: string | null;
  periodEnd: string;
  nextBilledAt: string | null;
  trialType: "free_payment_method_required" | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: number;
}

function buildSubscriptionFacts(data: Record<string, unknown>): SubscriptionFacts {
  const externalSubscriptionId = stringOrNull(data.id);
  const status = assertSubscriptionStatus(data.status);
  const period = subscriptionPeriod(data);
  const nextBilledAt = parseExternalInstant(data.next_billed_at, "subscription.next_billed_at");
  if (!externalSubscriptionId || !period.end) {
    throw new BillingProcessingError(
      "BILLING_DEPENDENCY_PENDING",
      "Paddle Subscription event does not yet contain a complete billing period.",
      "retry",
      { provider: "paddle", externalSubscriptionId, providerStatus: status },
    );
  }
  if (status === "trialing" && (!period.start || !nextBilledAt)) {
    throw new BillingProcessingError(
      "BILLING_DEPENDENCY_PENDING",
      "Paddle trialing Subscription is missing its trusted trial period or next billing time.",
      "retry",
      { provider: "paddle", externalSubscriptionId },
    );
  }
  const scheduledChange = asObject(data.scheduled_change);
  return {
    externalSubscriptionId,
    status,
    periodStart: period.start,
    periodEnd: period.end,
    nextBilledAt,
    trialType: status === "trialing" ? "free_payment_method_required" : null,
    trialStartedAt: status === "trialing" ? period.start : null,
    trialEndsAt: status === "trialing" ? period.end : null,
    cancelAtPeriodEnd: scheduledChange.action === "cancel" ? 1 : 0,
  };
}

async function fulfillInitialPurchase(input: {
  env: BillingWorkerEnv;
  event: InboundEventRow;
  transaction: PaddleWebhookEnvelope;
  subscription?: PaddleWebhookEnvelope;
  workerId: string;
  now: Date;
}): Promise<void> {
  const transactionId = stringOrNull(input.transaction.data.id);
  if (!transactionId) {
    throw new BillingProcessingError(
      "BILLING_TRANSACTION_ID_MISSING",
      "Paddle transaction.completed does not contain a Transaction ID.",
      "needs_attention",
      { externalEventId: input.transaction.event_id },
    );
  }
  const alreadyIssued = await input.env.DB.prepare(
    `SELECT id FROM licenses
     WHERE instance_id = ?1 AND source_billing_provider_id = ?2
       AND source_external_transaction_id = ?3
     LIMIT 1`,
  ).bind(input.event.instance_id, input.event.billing_provider_id, transactionId).first<{ id: string }>();
  if (alreadyIssued) {
    await markProcessed(
      input.env.DB,
      input.event,
      input.workerId,
      "duplicate_transaction",
      alreadyIssued.id,
      input.now.toISOString(),
    );
    return;
  }

  const items = extractPaddleLineItems(input.transaction.data);
  if (items.length !== 1 || items[0].quantity !== 1) {
    throw new BillingProcessingError(
      "BILLING_TRANSACTION_ITEMS_UNSUPPORTED",
      "Paddle Checkout must contain exactly one mapped Price with quantity 1.",
      "needs_attention",
      {
        provider: "paddle",
        externalEventId: input.transaction.event_id,
        externalTransactionId: transactionId,
        lineItemCount: items.length,
        lineItems: items,
      },
    );
  }
  const subscriptionFacts = input.subscription ? buildSubscriptionFacts(input.subscription.data) : null;
  const purchaseType = subscriptionFacts ? "subscription" : "one_time";
  const resolved = await resolveOfferAndVerification({
    env: input.env,
    event: input.event,
    payload: input.transaction,
    priceId: items[0].priceId,
    purchaseType,
    now: input.now,
  });
  const provider = await getBillingProvider(input.env.DB, input.event.instance_id, input.event.billing_provider_id);
  if (!provider) throw new BillingProcessingError("BILLING_PROVIDER_NOT_FOUND", "Billing Provider no longer exists.", "needs_attention");
  const externalCustomerId = stringOrNull(input.transaction.data.customer_id)
    ?? (input.subscription ? stringOrNull(input.subscription.data.customer_id) : null);
  const customer = await resolveCustomerForNewPurchase(input.env, input.event, provider, externalCustomerId, input.now);

  const effectiveAt = new Date(input.transaction.occurred_at);
  const offer = resolved.offer;
  let expiresAt: string | null = null;
  let updatesUntil: string | null = null;
  if (offer.license_model === "fixed_term") {
    if (!offer.default_term_seconds) {
      throw new BillingProcessingError("BILLING_LICENSE_PLAN_TERM_INVALID", "Fixed-term License Plan has no term.", "needs_attention", {
        offerId: offer.offer_id, licensePlanId: offer.plan_id,
      });
    }
    expiresAt = new Date(effectiveAt.getTime() + offer.default_term_seconds * 1000).toISOString();
  } else if (offer.license_model === "perpetual" && offer.update_window_seconds) {
    updatesUntil = new Date(effectiveAt.getTime() + offer.update_window_seconds * 1000).toISOString();
  } else if (offer.license_model === "subscription") {
    if (!subscriptionFacts) {
      throw new BillingProcessingError("BILLING_DEPENDENCY_PENDING", "Subscription facts are not available yet.", "retry", {
        externalTransactionId: transactionId,
      });
    }
    expiresAt = subscriptionFacts.periodEnd;
  }

  const licenseId = `lic_${ulid().toLowerCase()}`;
  const licenseKey = generateLicenseKey("LK");
  const keyHash = await hashLicenseKey(licenseKey);
  const nowIso = input.now.toISOString();
  const isVerification = resolved.verificationId !== null;
  const delivery = await prepareEmailNotificationDelivery({
    db: input.env.DB,
    env: input.env,
    instanceId: input.event.instance_id,
    customerId: customer.customerId,
    notificationType: licenseEmailNotificationType("customer.license_issued", offer.provider_environment),
    contractVersion: 1,
    recipientEmail: customer.email,
    variables: {
      product_id: offer.product_id,
      product_name: offer.product_name,
      license_id: licenseId,
      license_key: licenseKey,
      license_model: offer.license_model,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
      ...(updatesUntil ? { updates_until: updatesUntil } : {}),
    },
    now: input.now,
  });

  const statements: D1PreparedStatement[] = [input.env.DB.prepare(
    `INSERT INTO licenses (
       id, instance_id, customer_id, product_id, plan_id, plan_revision,
       license_model, renewal_mode, credential_mode, offline_grace_seconds,
       payment_grace_seconds, max_activations, features_json, key_hash,
       key_version, source, billing_environment, source_billing_provider_id, source_external_transaction_id,
       is_checkout_verification, status, status_reason, expires_at, updates_until,
       suspended_at, revoked_at, created_at, updated_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
       1, 'payment', ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, NULL, ?24, ?24
     )`,
  ).bind(
    licenseId,
    input.event.instance_id,
    customer.customerId,
    offer.product_id,
    offer.plan_id,
    offer.plan_revision,
    offer.license_model,
    offer.license_model === "subscription" ? "billing" : "none",
    offer.credential_mode,
    offer.offline_grace_seconds,
    offer.license_model === "subscription" ? offer.payment_grace_seconds : 0,
    offer.max_activations,
    offer.features_json,
    keyHash,
    offer.provider_environment,
    input.event.billing_provider_id,
    transactionId,
    isVerification ? 1 : 0,
    isVerification ? "suspended" : "active",
    isVerification ? "checkout_verification" : null,
    expiresAt,
    updatesUntil,
    isVerification ? nowIso : null,
    nowIso,
  )];

  if (subscriptionFacts) {
    const subscriptionId = `bsu_${ulid().toLowerCase()}`;
    statements.push(input.env.DB.prepare(
      `INSERT INTO billing_subscriptions (
         id, instance_id, billing_provider_id, license_id,
         external_subscription_id, external_customer_id, external_price_id,
         status, current_period_start, current_period_end, next_billed_at,
         trial_type, trial_started_at, trial_ends_at, cancel_at_period_end,
         last_external_occurred_at, last_external_event_id, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
         ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18
       )`,
    ).bind(
      subscriptionId,
      input.event.instance_id,
      input.event.billing_provider_id,
      licenseId,
      subscriptionFacts.externalSubscriptionId,
      externalCustomerId,
      items[0].priceId,
      subscriptionFacts.status,
      subscriptionFacts.periodStart,
      subscriptionFacts.periodEnd,
      subscriptionFacts.nextBilledAt,
      subscriptionFacts.trialType,
      subscriptionFacts.trialStartedAt,
      subscriptionFacts.trialEndsAt,
      subscriptionFacts.cancelAtPeriodEnd,
      input.subscription!.occurred_at,
      input.subscription!.event_id,
      nowIso,
    ));
  }
  statements.push(...delivery.statements);
  if (resolved.verificationId) {
    statements.push(input.env.DB.prepare(
      `UPDATE billing_checkout_verifications
       SET status = 'delivery_pending', external_transaction_id = ?1,
           license_id = ?2, delivery_id = ?3, updated_at = ?4
       WHERE instance_id = ?5 AND id = ?6 AND status = 'pending' AND expires_at > ?4`,
    ).bind(transactionId, licenseId, delivery.deliveryId, nowIso,
      input.event.instance_id, resolved.verificationId));
  }
  statements.push(processingResultStatement(
    input.env.DB,
    input.event,
    input.workerId,
    isVerification ? "checkout_verification_fulfilled" : "license_issued",
    licenseId,
    nowIso,
  ));
  statements.push(prepareLicenseAudit({
    db: input.env.DB,
    instanceId: input.event.instance_id,
    actor: { type: "system" },
    action: isVerification ? "billing.checkout_verification.fulfilled" : "billing.license.fulfilled",
    resourceType: "license",
    resourceId: licenseId,
    details: {
      billingProviderId: input.event.billing_provider_id,
      externalEventId: input.event.external_event_id,
      externalTransactionId: transactionId,
      externalSubscriptionId: subscriptionFacts?.externalSubscriptionId ?? null,
      offerId: offer.offer_id,
      customerId: customer.customerId,
      deliveryId: delivery.deliveryId,
      deliveryStatus: delivery.status,
      isCheckoutVerification: isVerification,
    },
    now: input.now,
  }));

  try {
    const results = await input.env.DB.batch(statements);
    if (resolved.verificationId) {
      const verificationResult = await Promise.resolve(results[results.length - 3] as D1Result | Promise<D1Result>);
      if ((verificationResult.meta?.changes ?? 0) !== 1) {
        throw new BillingProcessingError(
          "BILLING_CHECKOUT_VERIFICATION_CONSUME_CONFLICT",
          "Checkout verification token was consumed concurrently.",
          "needs_attention",
          { verificationId: resolved.verificationId, externalTransactionId: transactionId },
        );
      }
    }
  } catch (error) {
    if (error instanceof BillingProcessingError) throw error;
    if (String(error).includes("UNIQUE")) {
      const raced = await input.env.DB.prepare(
        `SELECT id FROM licenses
         WHERE instance_id = ?1 AND source_billing_provider_id = ?2
           AND source_external_transaction_id = ?3
         LIMIT 1`,
      ).bind(input.event.instance_id, input.event.billing_provider_id, transactionId).first<{ id: string }>();
      if (raced) {
        await markProcessed(input.env.DB, input.event, input.workerId, "duplicate_transaction", raced.id, nowIso);
        return;
      }
    }
    throw error;
  }
  if (delivery.status === "pending") {
    try {
      await dispatchDelivery({
        db: input.env.DB,
        env: input.env,
        instanceId: input.event.instance_id,
        deliveryId: delivery.deliveryId,
        now: input.now,
      });
    } catch (error) {
      // License, Billing facts, and the pending Delivery were committed in the
      // preceding batch. The shared Scheduler recovers the same Delivery; an
      // immediate trigger failure must not rewrite those durable facts.
      console.error("Billing fulfillment email Delivery immediate trigger failed", {
        code: "EMAIL_DELIVERY_IMMEDIATE_TRIGGER_FAILED",
        instanceId: input.event.instance_id,
        deliveryId: delivery.deliveryId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

async function processExistingSubscriptionUpdate(input: {
  env: BillingWorkerEnv;
  event: InboundEventRow;
  payload: PaddleWebhookEnvelope;
  existing: ExistingSubscriptionRow;
  workerId: string;
  now: Date;
}): Promise<void> {
  if (input.existing.last_external_occurred_at &&
      input.existing.last_external_occurred_at >= input.payload.occurred_at) {
    await markProcessed(input.env.DB, input.event, input.workerId, "ignored_as_stale",
      input.existing.id, input.now.toISOString());
    return;
  }
  const facts = buildSubscriptionFacts(input.payload.data);
  const items = extractPaddleLineItems(input.payload.data);
  if (items.length !== 1 || items[0].quantity !== 1) {
    throw new BillingProcessingError(
      "BILLING_SUBSCRIPTION_ITEMS_UNSUPPORTED",
      "Paddle Subscription must contain exactly one Price with quantity 1.",
      "needs_attention",
      { externalSubscriptionId: facts.externalSubscriptionId, lineItems: items },
    );
  }
  const nowIso = input.now.toISOString();
  const statements: D1PreparedStatement[] = [input.env.DB.prepare(
    `UPDATE billing_subscriptions
     SET external_price_id = ?1, status = ?2, current_period_start = ?3,
         current_period_end = ?4, next_billed_at = ?5, trial_type = ?6,
         trial_started_at = ?7, trial_ends_at = ?8, cancel_at_period_end = ?9,
         last_external_occurred_at = ?10, last_external_event_id = ?11, updated_at = ?12
     WHERE instance_id = ?13 AND id = ?14`,
  ).bind(
    items[0].priceId,
    facts.status,
    facts.periodStart,
    facts.periodEnd,
    facts.nextBilledAt,
    facts.trialType,
    facts.trialStartedAt,
    facts.trialEndsAt,
    facts.cancelAtPeriodEnd,
    input.payload.occurred_at,
    input.payload.event_id,
    nowIso,
    input.event.instance_id,
    input.existing.id,
  )];
  if (!input.existing.is_checkout_verification) {
    if (facts.status === "active" || facts.status === "trialing") {
      statements.push(input.env.DB.prepare(
        `UPDATE licenses
         SET expires_at = ?1,
             status = CASE WHEN status = 'suspended' AND status_reason = 'payment_past_due' THEN 'active' ELSE status END,
             status_reason = CASE WHEN status = 'suspended' AND status_reason = 'payment_past_due' THEN NULL ELSE status_reason END,
             suspended_at = CASE WHEN status = 'suspended' AND status_reason = 'payment_past_due' THEN NULL ELSE suspended_at END,
             updated_at = ?2
         WHERE instance_id = ?3 AND id = ?4 AND renewal_mode = 'billing'`,
      ).bind(facts.periodEnd, nowIso, input.event.instance_id, input.existing.license_id));
    } else if (facts.status === "paused") {
      statements.push(input.env.DB.prepare(
        `UPDATE licenses
         SET status = 'suspended', status_reason = 'billing_paused', suspended_at = ?1, updated_at = ?1
         WHERE instance_id = ?2 AND id = ?3 AND renewal_mode = 'billing' AND status <> 'revoked'`,
      ).bind(nowIso, input.event.instance_id, input.existing.license_id));
    } else {
      // past_due keeps access through the paid period plus the snapshotted grace.
      // canceled keeps the trusted period end; validation expires it by time.
      statements.push(input.env.DB.prepare(
        `UPDATE licenses SET expires_at = ?1, updated_at = ?2
         WHERE instance_id = ?3 AND id = ?4 AND renewal_mode = 'billing'`,
      ).bind(facts.periodEnd, nowIso, input.event.instance_id, input.existing.license_id));
    }
  }
  statements.push(processingResultStatement(
    input.env.DB,
    input.event,
    input.workerId,
    input.existing.is_checkout_verification ? "checkout_verification_subscription_synced" : `subscription_${facts.status}`,
    input.existing.id,
    nowIso,
  ));
  await input.env.DB.batch(statements);
}

async function processTransactionForExistingSubscription(input: {
  env: BillingWorkerEnv;
  event: InboundEventRow;
  payload: PaddleWebhookEnvelope;
  existing: ExistingSubscriptionRow;
  workerId: string;
  now: Date;
}): Promise<void> {
  const period = transactionPeriod(input.payload.data);
  const nowIso = input.now.toISOString();
  const statements: D1PreparedStatement[] = [];
  if (period.end && (!input.existing.last_external_occurred_at || input.existing.last_external_occurred_at < input.payload.occurred_at)) {
    statements.push(input.env.DB.prepare(
      `UPDATE billing_subscriptions
       SET status = CASE WHEN status IN ('past_due', 'trialing') THEN 'active' ELSE status END,
           current_period_start = COALESCE(?1, current_period_start),
           current_period_end = ?2, last_external_occurred_at = ?3,
           last_external_event_id = ?4, updated_at = ?5
       WHERE instance_id = ?6 AND id = ?7`,
    ).bind(period.start, period.end, input.payload.occurred_at, input.payload.event_id,
      nowIso, input.event.instance_id, input.existing.id));
    if (!input.existing.is_checkout_verification) {
      statements.push(input.env.DB.prepare(
        `UPDATE licenses
         SET expires_at = ?1,
             status = CASE WHEN status = 'suspended' AND status_reason = 'payment_past_due' THEN 'active' ELSE status END,
             status_reason = CASE WHEN status = 'suspended' AND status_reason = 'payment_past_due' THEN NULL ELSE status_reason END,
             suspended_at = CASE WHEN status = 'suspended' AND status_reason = 'payment_past_due' THEN NULL ELSE suspended_at END,
             updated_at = ?2
         WHERE instance_id = ?3 AND id = ?4 AND renewal_mode = 'billing'`,
      ).bind(period.end, nowIso, input.event.instance_id, input.existing.license_id));
    }
  }
  statements.push(processingResultStatement(
    input.env.DB,
    input.event,
    input.workerId,
    input.existing.is_checkout_verification ? "checkout_verification_transaction_synced" : "subscription_renewed",
    input.existing.id,
    nowIso,
  ));
  await input.env.DB.batch(statements);
}

async function processTransactionEvent(
  env: BillingWorkerEnv,
  event: InboundEventRow,
  payload: PaddleWebhookEnvelope,
  workerId: string,
  now: Date,
): Promise<void> {
  const subscriptionId = stringOrNull(payload.data.subscription_id);
  if (subscriptionId) {
    const existing = await getExistingSubscription(env.DB, event.instance_id, event.billing_provider_id, subscriptionId);
    if (existing) {
      await processTransactionForExistingSubscription({ env, event, payload, existing, workerId, now });
      return;
    }
    const subscription = await loadCorrelatedEvent(
      env,
      event,
      "subscription.created",
      "external_subscription_id",
      subscriptionId,
    );
    if (!subscription) {
      throw new BillingProcessingError(
        "BILLING_DEPENDENCY_PENDING",
        "Waiting for Paddle subscription.created before initial subscription fulfillment.",
        "retry",
        { externalTransactionId: stringOrNull(payload.data.id), externalSubscriptionId: subscriptionId },
      );
    }
    await fulfillInitialPurchase({ env, event, transaction: payload, subscription: subscription.payload, workerId, now });
    return;
  }
  await fulfillInitialPurchase({ env, event, transaction: payload, workerId, now });
}

async function processSubscriptionCreatedEvent(
  env: BillingWorkerEnv,
  event: InboundEventRow,
  payload: PaddleWebhookEnvelope,
  workerId: string,
  now: Date,
): Promise<void> {
  const subscriptionId = stringOrNull(payload.data.id);
  if (!subscriptionId) {
    throw new BillingProcessingError("BILLING_SUBSCRIPTION_ID_MISSING", "Paddle Subscription ID is missing.", "needs_attention");
  }
  const existing = await getExistingSubscription(env.DB, event.instance_id, event.billing_provider_id, subscriptionId);
  if (existing) {
    await processExistingSubscriptionUpdate({ env, event, payload, existing, workerId, now });
    return;
  }
  const transactionId = stringOrNull(payload.data.transaction_id);
  if (!transactionId) {
    throw new BillingProcessingError(
      "BILLING_DEPENDENCY_PENDING",
      "Paddle subscription.created has not identified its initial Transaction yet.",
      "retry",
      { externalSubscriptionId: subscriptionId },
    );
  }
  const transaction = await loadCorrelatedEvent(
    env,
    event,
    "transaction.completed",
    "external_transaction_id",
    transactionId,
  );
  if (!transaction) {
    throw new BillingProcessingError(
      "BILLING_DEPENDENCY_PENDING",
      "Waiting for Paddle transaction.completed before initial subscription fulfillment.",
      "retry",
      { externalTransactionId: transactionId, externalSubscriptionId: subscriptionId },
    );
  }
  await fulfillInitialPurchase({ env, event, transaction: transaction.payload, subscription: payload, workerId, now });
}

async function processSubscriptionUpdatedEvent(
  env: BillingWorkerEnv,
  event: InboundEventRow,
  payload: PaddleWebhookEnvelope,
  workerId: string,
  now: Date,
): Promise<void> {
  const subscriptionId = stringOrNull(payload.data.id);
  if (!subscriptionId) throw new BillingProcessingError("BILLING_SUBSCRIPTION_ID_MISSING", "Paddle Subscription ID is missing.", "needs_attention");
  const existing = await getExistingSubscription(env.DB, event.instance_id, event.billing_provider_id, subscriptionId);
  if (!existing) {
    throw new BillingProcessingError(
      "BILLING_DEPENDENCY_PENDING",
      "Paddle Subscription is not linked to a License yet.",
      "retry",
      { externalSubscriptionId: subscriptionId },
    );
  }
  await processExistingSubscriptionUpdate({ env, event, payload, existing, workerId, now });
}

function adjustmentSemantics(action: string, type: string | null, status: string): {
  automaticEffect: "none" | "license_suspended";
  reviewStatus: "not_required" | "open";
  eventStatus: "processed" | "needs_attention";
} {
  if ((action === "refund" && type === "full" && status === "approved") || action === "chargeback") {
    return { automaticEffect: "license_suspended", reviewStatus: "open", eventStatus: "needs_attention" };
  }
  if (
    (action === "refund" && status === "pending_approval") ||
    (action === "refund" && type === "partial" && status === "approved") ||
    action === "chargeback_warning" ||
    action === "chargeback_reverse" ||
    action === "chargeback_warning_reverse" ||
    status === "reversed"
  ) {
    return { automaticEffect: "none", reviewStatus: "open", eventStatus: "needs_attention" };
  }
  return { automaticEffect: "none", reviewStatus: "not_required", eventStatus: "processed" };
}

async function processAdjustmentEvent(
  env: BillingWorkerEnv,
  event: InboundEventRow,
  payload: PaddleWebhookEnvelope,
  workerId: string,
  now: Date,
): Promise<void> {
  const data = payload.data;
  const externalAdjustmentId = stringOrNull(data.id);
  const externalTransactionId = stringOrNull(data.transaction_id);
  const externalCustomerId = stringOrNull(data.customer_id);
  const action = stringOrNull(data.action);
  const type = stringOrNull(data.type);
  const status = stringOrNull(data.status);
  const totals = asObject(data.totals);
  const currencyCode = stringOrNull(data.currency_code) ?? stringOrNull(totals.currency_code);
  const totalAmount = stringOrNull(data.total) ?? stringOrNull(totals.total);
  const allowedActions = new Set([
    "credit", "refund", "chargeback", "chargeback_reverse",
    "chargeback_warning", "chargeback_warning_reverse", "credit_reverse",
  ]);
  const allowedStatuses = new Set(["pending_approval", "approved", "rejected", "reversed"]);
  if (!externalAdjustmentId || !externalTransactionId || !externalCustomerId ||
      !action || !allowedActions.has(action) || !status || !allowedStatuses.has(status) ||
      !currencyCode || !totalAmount || (type !== null && type !== "full" && type !== "partial")) {
    throw new BillingProcessingError(
      "BILLING_ADJUSTMENT_CONTRACT_UNSUPPORTED",
      "Paddle Adjustment contains missing or unsupported action, type, status, or amount fields.",
      "needs_attention",
      {
        provider: "paddle",
        externalAdjustmentId,
        externalTransactionId,
        action,
        type,
        status,
        currencyCode,
        totalAmount,
      },
    );
  }
  const existing = await env.DB.prepare(
    `SELECT id, last_external_occurred_at
     FROM billing_adjustments
     WHERE instance_id = ?1 AND billing_provider_id = ?2 AND external_adjustment_id = ?3
     LIMIT 1`,
  ).bind(event.instance_id, event.billing_provider_id, externalAdjustmentId).first<{
    id: string; last_external_occurred_at: string;
  }>();
  if (existing && existing.last_external_occurred_at >= payload.occurred_at) {
    await markProcessed(env.DB, event, workerId, "ignored_as_stale", existing.id, now.toISOString());
    return;
  }
  const license = await env.DB.prepare(
    `SELECT id, is_checkout_verification
     FROM licenses
     WHERE instance_id = ?1 AND source_billing_provider_id = ?2
       AND source_external_transaction_id = ?3
     LIMIT 1`,
  ).bind(event.instance_id, event.billing_provider_id, externalTransactionId).first<{
    id: string; is_checkout_verification: number;
  }>();
  const baseSemantic = adjustmentSemantics(action, type, status);
  // A provider event can request an automatic suspension only after the
  // referenced transaction resolves to a concrete License. Otherwise persist
  // the exact Adjustment for review without claiming an effect occurred.
  const semantic = baseSemantic.automaticEffect === "license_suspended" && !license
    ? { automaticEffect: "none" as const, reviewStatus: "open" as const, eventStatus: "needs_attention" as const }
    : baseSemantic;
  const adjustmentId = existing?.id ?? `bad_${ulid().toLowerCase()}`;
  const nowIso = now.toISOString();
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO billing_adjustments (
       id, instance_id, billing_provider_id, license_id, external_adjustment_id,
       external_transaction_id, external_subscription_id, external_customer_id,
       provider_action, adjustment_type, provider_status, currency_code,
       total_amount, provider_reason, automatic_effect, review_status,
       last_external_occurred_at, last_external_event_id, created_at, updated_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
       ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19
     )
     ON CONFLICT(instance_id, billing_provider_id, external_adjustment_id) DO UPDATE SET
       license_id = excluded.license_id,
       external_transaction_id = excluded.external_transaction_id,
       external_subscription_id = excluded.external_subscription_id,
       external_customer_id = excluded.external_customer_id,
       provider_action = excluded.provider_action,
       adjustment_type = excluded.adjustment_type,
       provider_status = excluded.provider_status,
       currency_code = excluded.currency_code,
       total_amount = excluded.total_amount,
       provider_reason = excluded.provider_reason,
       automatic_effect = excluded.automatic_effect,
       review_status = excluded.review_status,
       resolution_action = NULL, resolution_reason = NULL,
       resolved_by_user_id = NULL, resolved_at = NULL,
       last_external_occurred_at = excluded.last_external_occurred_at,
       last_external_event_id = excluded.last_external_event_id,
       updated_at = excluded.updated_at`,
  ).bind(
    adjustmentId,
    event.instance_id,
    event.billing_provider_id,
    license?.id ?? null,
    externalAdjustmentId,
    externalTransactionId,
    stringOrNull(data.subscription_id),
    externalCustomerId,
    action,
    type,
    status,
    currencyCode,
    totalAmount,
    stringOrNull(data.reason),
    semantic.automaticEffect,
    semantic.reviewStatus,
    payload.occurred_at,
    payload.event_id,
    nowIso,
  )];
  if (semantic.automaticEffect === "license_suspended" && license && !license.is_checkout_verification) {
    statements.push(env.DB.prepare(
      `UPDATE licenses
       SET status = 'suspended', status_reason = 'billing_adjustment', suspended_at = ?1, updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3 AND status <> 'revoked'`,
    ).bind(nowIso, event.instance_id, license.id));
  }
  if (semantic.eventStatus === "processed") {
    statements.push(processingResultStatement(env.DB, event, workerId, "billing_adjustment_recorded", adjustmentId, nowIso));
  } else {
    statements.push(env.DB.prepare(
      `UPDATE inbound_events
       SET status = 'needs_attention', result_type = 'billing_adjustment_review',
           result_reference_id = ?1, last_error_code = ?2, last_error_detail = ?3,
           next_attempt_at = NULL, locked_by = NULL, locked_until = NULL,
           processed_at = ?4, updated_at = ?4
       WHERE instance_id = ?5 AND id = ?6 AND status = 'processing' AND locked_by = ?7`,
    ).bind(
      adjustmentId,
      "BILLING_ADJUSTMENT_REVIEW_REQUIRED",
      serializeBillingDiagnostic({ provider: "paddle", externalAdjustmentId, action, type, status, licenseId: license?.id ?? null }),
      nowIso,
      event.instance_id,
      event.id,
      workerId,
    ));
  }
  statements.push(prepareLicenseAudit({
    db: env.DB,
    instanceId: event.instance_id,
    actor: { type: "system" },
    action: "billing.adjustment.recorded",
    resourceType: "billing_adjustment",
    resourceId: adjustmentId,
    details: {
      billingProviderId: event.billing_provider_id,
      externalEventId: event.external_event_id,
      externalAdjustmentId,
      externalTransactionId,
      licenseId: license?.id ?? null,
      providerAction: action,
      adjustmentType: type,
      providerStatus: status,
      automaticEffect: semantic.automaticEffect,
      reviewStatus: semantic.reviewStatus,
    },
    now,
  }));
  await env.DB.batch(statements);
}

async function scheduleFailure(
  env: BillingWorkerEnv,
  event: InboundEventRow,
  workerId: string,
  error: unknown,
  now: Date,
): Promise<void> {
  const normalized = error instanceof BillingProcessingError
    ? error
    : new BillingProcessingError(
        "BILLING_PROCESSING_UNEXPECTED",
        error instanceof Error ? error.message : "Unexpected Billing processing failure.",
        "retry",
        { errorName: error instanceof Error ? error.name : typeof error },
      );
  // attempt_count is incremented by the lease claim before the event row is
  // loaded. Reusing that persisted count avoids counting one execution twice.
  const attempts = event.attempt_count;
  let status = normalized.disposition === "needs_attention" ? "needs_attention" : normalized.disposition;
  // Recoverable provider/dependency failures stay pending until their explicit
  // dependency timeout or encrypted payload expiry moves them to attention.
  // An arbitrary attempt cap would turn normal webhook reordering into a
  // permanent failure long before the documented recovery window closes.
  if (status === "retry") status = "pending";
  const delaySeconds = Math.min(3600, Math.max(5, 5 * 2 ** Math.min(attempts - 1, 9)));
  const nextAttemptAt = status === "pending" ? new Date(now.getTime() + delaySeconds * 1000).toISOString() : null;
  const nowIso = now.toISOString();
  const detailJson = serializeBillingDiagnostic({ message: normalized.message, ...normalized.details });
  await env.DB.batch([
    prepareSystemIssueUpsert({
      db: env.DB,
      instanceId: event.instance_id,
      category: "webhook",
      sourceType: "inbound_event",
      sourceId: event.id,
      operation: event.external_event_type,
      errorCode: normalized.code,
      errorDetailJson: detailJson,
      nowIso,
    }),
    env.DB.prepare(
      `UPDATE inbound_events
       SET status = ?1, next_attempt_at = ?2, locked_by = NULL, locked_until = NULL,
           last_error_code = ?3, last_error_detail = ?4, updated_at = ?5,
           processed_at = CASE WHEN ?1 IN ('failed', 'needs_attention') THEN ?5 ELSE processed_at END
       WHERE instance_id = ?6 AND id = ?7 AND status = 'processing' AND locked_by = ?8`,
    ).bind(
      status,
      nextAttemptAt,
      normalized.code,
      detailJson,
      nowIso,
      event.instance_id,
      event.id,
      workerId,
    ),
  ]);
}

export async function processBillingInboundEvent(input: {
  env: BillingWorkerEnv;
  instanceId: string;
  eventId: string;
  workerId: string;
  leaseSeconds?: number;
  now?: Date;
}): Promise<{ processed: boolean; status: string }> {
  const now = input.now ?? new Date();
  const selectEvent = () => input.env.DB.prepare(
    `SELECT id, instance_id, billing_provider_id, external_event_id, external_event_type,
            external_customer_id, external_transaction_id, external_subscription_id,
            external_adjustment_id, external_occurred_at, payload_ciphertext,
            payload_expires_at, status,
            attempt_count, locked_by, received_at
     FROM inbound_events
     WHERE instance_id = ?1 AND id = ?2
     LIMIT 1`,
  ).bind(input.instanceId, input.eventId).first<InboundEventRow>();
  let event = await selectEvent();
  if (!event) return { processed: false, status: "not_found" };
  if (event.status === "pending") {
    const leaseSeconds = Math.min(300, Math.max(15, input.leaseSeconds ?? 60));
    const lockedUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const claim = await input.env.DB.prepare(
      `UPDATE inbound_events
       SET status = 'processing', locked_by = ?1, locked_until = ?2,
           attempt_count = attempt_count + 1, updated_at = ?3
       WHERE instance_id = ?4 AND id = ?5 AND status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)`,
    ).bind(input.workerId, lockedUntil, now.toISOString(), input.instanceId, input.eventId).run();
    if ((claim.meta.changes ?? 0) !== 1) {
      event = await selectEvent();
    } else {
      event = await selectEvent();
    }
  }
  if (!event || event.status !== "processing" || event.locked_by !== input.workerId) {
    return { processed: false, status: event?.status ?? "not_found" };
  }

  try {
    // A Simulator event stored by an older webhook route must never enter the
    // platform fulfillment path when the scheduler encounters it later.
    if (event.external_event_id.startsWith("ntfsimevt_")) {
      await markProcessed(input.env.DB, event, input.workerId, "ignored_simulation_event", null, now.toISOString());
      return { processed: true, status: "processed" };
    }
    if (!event.external_event_id.startsWith("evt_")) {
      throw new BillingProcessingError(
        "BILLING_WEBHOOK_SOURCE_UNKNOWN",
        "Stored Paddle event ID does not identify a platform event.",
        "needs_attention",
        { inboundEventId: event.id, externalEventId: event.external_event_id },
      );
    }
    const payload = await loadEventPayload(input.env, event, now);
    const provider = await getBillingProvider(input.env.DB, event.instance_id, event.billing_provider_id);
    if (!provider || provider.provider !== "paddle") {
      throw new BillingProcessingError(
        "BILLING_PROVIDER_UNAVAILABLE",
        "The Billing Provider for this event is missing or unsupported.",
        "needs_attention",
        { billingProviderId: event.billing_provider_id },
      );
    }
    switch (payload.event_type) {
      case "customer.created":
      case "customer.updated":
        await processCustomerEvent(input.env, event, payload, input.workerId, now);
        break;
      case "transaction.completed":
        await processTransactionEvent(input.env, event, payload, input.workerId, now);
        break;
      case "subscription.created":
        await processSubscriptionCreatedEvent(input.env, event, payload, input.workerId, now);
        break;
      case "subscription.updated":
        await processSubscriptionUpdatedEvent(input.env, event, payload, input.workerId, now);
        break;
      case "adjustment.created":
      case "adjustment.updated":
        await processAdjustmentEvent(input.env, event, payload, input.workerId, now);
        break;
      default:
        await markProcessed(input.env.DB, event, input.workerId, "ignored_event_type", null, now.toISOString());
        break;
    }
  } catch (error) {
    if (error instanceof PaddleHttpError && error.code === "BILLING_PROVIDER_API_AUTH_INVALID") {
      await recordInboundEventProviderAuthIssue({
        db: input.env.DB,
        instanceId: event.instance_id,
        billingProviderId: event.billing_provider_id,
        inboundEventId: event.id,
        workerId: input.workerId,
        issueCode: error.code,
        providerError: error.providerDetails,
        now,
      });
    } else {
      await scheduleFailure(input.env, event, input.workerId, error, now);
    }
  }
  const final = await input.env.DB.prepare(
    `SELECT status FROM inbound_events WHERE instance_id = ?1 AND id = ?2 LIMIT 1`,
  ).bind(input.instanceId, input.eventId).first<{ status: string }>();
  return { processed: final?.status === "processed", status: final?.status ?? "not_found" };
}

async function enforcePaymentGraceDeadlines(
  env: BillingWorkerEnv,
  instanceId: string,
  now: Date,
  limit: number,
): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT license.id
     FROM billing_subscriptions AS subscription
     JOIN licenses AS license
       ON license.instance_id = subscription.instance_id AND license.id = subscription.license_id
     WHERE subscription.instance_id = ?1
       AND subscription.status = 'past_due'
       AND license.status = 'active'
       AND license.is_checkout_verification = 0
       AND datetime(license.expires_at, '+' || license.payment_grace_seconds || ' seconds') <= datetime(?2)
     ORDER BY license.expires_at ASC
     LIMIT ?3`,
  ).bind(instanceId, now.toISOString(), limit).all<{ id: string }>();
  let suspended = 0;
  for (const license of due.results) {
    const result = await env.DB.prepare(
      `UPDATE licenses
       SET status = 'suspended', status_reason = 'payment_past_due',
           suspended_at = ?1, updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3 AND status = 'active'
         AND is_checkout_verification = 0`,
    ).bind(now.toISOString(), instanceId, license.id).run();
    suspended += result.meta.changes ?? 0;
  }
  return suspended;
}

export async function processDueBillingInboundEvents(
  env: BillingWorkerEnv,
  options: {
    instanceLimit?: number;
    eventLimitPerInstance?: number;
    graceLimitPerInstance?: number;
    leaseSeconds?: number;
    now?: Date;
    workerId?: string;
  } = {},
): Promise<{ instances: number; claimed: number; processed: number; needsAttention: number; failed: number; graceSuspended: number }> {
  const now = options.now ?? new Date();
  const instancePageSize = Math.min(500, Math.max(1, options.instanceLimit ?? 100));
  const eventLimit = Math.min(100, Math.max(1, options.eventLimitPerInstance ?? 25));
  const graceLimit = Math.min(100, Math.max(1, options.graceLimitPerInstance ?? 25));
  const leaseSeconds = Math.min(300, Math.max(15, options.leaseSeconds ?? 60));
  const workerId = options.workerId ?? `billing_${ulid().toLowerCase()}`;
  const summary = { instances: 0, claimed: 0, processed: 0, needsAttention: 0, failed: 0, graceSuspended: 0 };
  let instanceCursor = "";
  while (true) {
    const instances = await env.DB.prepare(
      `SELECT candidate.instance_id AS id
       FROM (
         SELECT event.instance_id
         FROM inbound_events AS event
         JOIN instances AS instance ON instance.id = event.instance_id
         WHERE instance.status = 'active'
           AND (
             (event.status = 'pending'
               AND (event.next_attempt_at IS NULL OR event.next_attempt_at <= ?2))
             OR (event.status = 'processing' AND event.locked_until <= ?2)
           )
         UNION
         SELECT license.instance_id
         FROM billing_subscriptions AS subscription
         JOIN licenses AS license
           ON license.instance_id = subscription.instance_id
          AND license.id = subscription.license_id
         JOIN instances AS instance ON instance.id = license.instance_id
         WHERE instance.status = 'active'
           AND subscription.status = 'past_due'
           AND license.status = 'active'
           AND license.is_checkout_verification = 0
           AND datetime(license.expires_at, '+' || license.payment_grace_seconds || ' seconds') <= datetime(?2)
       ) AS candidate
       WHERE candidate.instance_id > ?1
       ORDER BY candidate.instance_id
       LIMIT ?3`,
    ).bind(instanceCursor, now.toISOString(), instancePageSize).all<{ id: string }>();
    if (instances.results.length === 0) break;
    summary.instances += instances.results.length;
    for (const instance of instances.results) {
      const due = await env.DB.prepare(
        `SELECT id
         FROM inbound_events
         WHERE instance_id = ?1
           AND (
             (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?2))
             OR (status = 'processing' AND locked_until <= ?2)
           )
         ORDER BY received_at ASC
         LIMIT ?3`,
      ).bind(instance.id, now.toISOString(), eventLimit).all<{ id: string }>();
      for (const candidate of due.results) {
        const lockedUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
        const claim = await env.DB.prepare(
          `UPDATE inbound_events
           SET status = 'processing', locked_by = ?1, locked_until = ?2,
               attempt_count = attempt_count + 1, updated_at = ?3
           WHERE instance_id = ?4 AND id = ?5
             AND (
               (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
               OR (status = 'processing' AND locked_until <= ?3)
             )`,
        ).bind(workerId, lockedUntil, now.toISOString(), instance.id, candidate.id).run();
        if ((claim.meta.changes ?? 0) !== 1) continue;
        summary.claimed++;
        const result = await processBillingInboundEvent({
          env,
          instanceId: instance.id,
          eventId: candidate.id,
          workerId,
          now,
        });
        if (result.status === "processed") summary.processed++;
        else if (result.status === "needs_attention") summary.needsAttention++;
        else if (result.status === "failed") summary.failed++;
      }
      summary.graceSuspended += await enforcePaymentGraceDeadlines(env, instance.id, now, graceLimit);
    }
    instanceCursor = instances.results[instances.results.length - 1].id;
  }
  return summary;
}
