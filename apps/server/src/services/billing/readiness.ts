import type {
  CheckoutReadiness,
  ReadinessCheck,
} from "../../infra/billing/types";
import { assertPaddleClientToken } from "../../infra/billing/paddle";
import { EMAIL_NOTIFICATION_CONTRACTS } from "../../domain/email/contracts";
import { decryptEnvelopeV1, type DeliveryCryptoEnv } from "../../infra/delivery/crypto";
import { getEmailProviderAdapter } from "../../infra/email/provider";

export interface BillingOfferReadinessRow {
  id: string;
  instance_id: string;
  external_price_id: string;
  product_id: string;
  license_plan_id: string;
  purchase_type: "one_time" | "subscription";
  offer_status: "draft" | "active" | "archived";
  product_status: "active" | "archived";
  license_model: "perpetual" | "fixed_term" | "subscription";
  credential_mode: "opaque" | "signed";
  plan_status: "active" | "archived";
  provider_id: string;
  provider_status: "active" | "disabled";
  provider_environment: "sandbox" | "live";
  client_side_token: string;
  webhook_secret_ciphertext: string;
}

function check(key: string, ready: boolean, reasonCode?: string, details?: Record<string, unknown>): ReadinessCheck {
  return { key, status: ready ? "ready" : "not_ready", ...(ready ? {} : { reasonCode }), ...(details ? { details } : {}) };
}

export async function getBillingOfferReadinessRow(
  db: D1Database,
  instanceId: string,
  offerId: string,
): Promise<BillingOfferReadinessRow | null> {
  const row = await db.prepare(
    `SELECT
       offer.id, offer.instance_id, offer.external_price_id, offer.product_id,
       offer.license_plan_id, offer.purchase_type, offer.status AS offer_status,
       product.status AS product_status,
       plan.license_model, plan.credential_mode, plan.status AS plan_status,
       provider.id AS provider_id, provider.status AS provider_status,
       provider.environment AS provider_environment,
       provider.client_side_token, provider.webhook_secret_ciphertext
     FROM billing_offers AS offer
     JOIN products AS product
       ON product.instance_id = offer.instance_id AND product.id = offer.product_id
     JOIN license_plans AS plan
       ON plan.instance_id = offer.instance_id
      AND plan.product_id = offer.product_id
      AND plan.id = offer.license_plan_id
     JOIN billing_providers AS provider
       ON provider.instance_id = offer.instance_id AND provider.id = offer.billing_provider_id
     WHERE offer.instance_id = ?1 AND offer.id = ?2
     LIMIT 1`,
  ).bind(instanceId, offerId).first<BillingOfferReadinessRow>();
  return row ?? null;
}

interface EmailDeliveryReadinessRow {
  integration_id: string;
  provider: string;
  credential_ciphertext: string;
  active_binding_count: number;
}

const LICENSE_ISSUED_EMAIL_CONTRACT = EMAIL_NOTIFICATION_CONTRACTS.find(
  (contract) => contract.notificationType === "customer.license_issued",
);
if (!LICENSE_ISSUED_EMAIL_CONTRACT) {
  throw new Error("The customer.license_issued Email contract must be registered.");
}
const OFFER_ACTIVATION_EMAIL_CONTRACTS = Object.freeze([{
  notificationType: LICENSE_ISSUED_EMAIL_CONTRACT.notificationType,
  contractVersion: LICENSE_ISSUED_EMAIL_CONTRACT.version,
}]);

async function emailDeliveryReadiness(
  db: D1Database,
  env: DeliveryCryptoEnv,
  instanceId: string,
): Promise<{
  integrationReady: boolean;
  credentialReady: boolean;
  bindingsReady: boolean;
  integrationId?: string;
  credentialErrorCode?: string;
  activeBindingCount: number;
}> {
  const contractPredicate = (alias: string) => OFFER_ACTIVATION_EMAIL_CONTRACTS
    .map((_, index) => `(${alias}.notification_type = ?${index * 2 + 2} AND ${alias}.contract_version = ?${index * 2 + 3})`)
    .join(" OR ");
  const bindings = OFFER_ACTIVATION_EMAIL_CONTRACTS.flatMap((contract) => [
    contract.notificationType,
    contract.contractVersion,
  ]);
  const result = await db.prepare(
    `SELECT integration.id AS integration_id, integration.provider,
            integration.credential_ciphertext,
            COUNT(DISTINCT binding.notification_type || '@' || binding.contract_version) AS active_binding_count
     FROM email_integrations AS integration
     LEFT JOIN email_template_bindings AS binding
       ON binding.instance_id = integration.instance_id
      AND binding.email_integration_id = integration.id
      AND binding.status = 'active'
      AND (${contractPredicate("binding")})
     WHERE integration.instance_id = ?1
       AND integration.status = 'active'
     GROUP BY integration.id, integration.provider, integration.credential_ciphertext
     LIMIT 1`,
  ).bind(instanceId, ...bindings).all<EmailDeliveryReadinessRow>();
  const row = result.results[0];
  if (!row) {
    return {
      integrationReady: false,
      credentialReady: false,
      bindingsReady: false,
      activeBindingCount: 0,
    };
  }

  let credentialReady = false;
  let credentialErrorCode: string | undefined;
  try {
    const serialized = await decryptEnvelopeV1(row.credential_ciphertext, env, {
      instanceId,
      table: "email_integrations",
      rowId: row.integration_id,
      field: "credential_ciphertext",
    });
    const envelope = JSON.parse(serialized) as unknown;
    getEmailProviderAdapter(row.provider).validateCredentialEnvelope(envelope);
    credentialReady = true;
  } catch (error) {
    credentialErrorCode = error instanceof SyntaxError
      ? "EMAIL_PROVIDER_CREDENTIAL_ENVELOPE_INVALID"
      : "EMAIL_PROVIDER_CREDENTIAL_UNAVAILABLE";
  }

  const requiredCount = OFFER_ACTIVATION_EMAIL_CONTRACTS.length;
  return {
    integrationReady: true,
    credentialReady,
    bindingsReady: Number(row.active_binding_count) === requiredCount,
    integrationId: row.integration_id,
    ...(credentialErrorCode ? { credentialErrorCode } : {}),
    activeBindingCount: Number(row.active_binding_count),
  };
}

async function processingBacklogHealthy(db: D1Database, instanceId: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
  const result = await db.prepare(
    `SELECT 1 AS unavailable
     FROM inbound_events
     WHERE instance_id = ?1
       AND (
         (status = 'pending' AND COALESCE(next_attempt_at, received_at) < ?2)
         OR (status = 'processing' AND locked_until < ?3)
       )
     LIMIT 1`,
  ).bind(instanceId, staleBefore, now.toISOString()).all<{ unavailable: number }>();
  return !result.results[0];
}

export async function evaluateBillingOfferReadiness(
  db: D1Database,
  row: BillingOfferReadinessRow,
  options: { env: DeliveryCryptoEnv; now?: Date; activation?: boolean },
): Promise<CheckoutReadiness> {
  const now = options.now ?? new Date();
  const checks: ReadinessCheck[] = [];
  checks.push(check("product", row.product_status === "active", "PRODUCT_UNAVAILABLE"));
  checks.push(check("license_plan", row.plan_status === "active", "CHECKOUT_CONFIGURATION_PENDING"));
  checks.push(check("provider", row.provider_status === "active", "CHECKOUT_PROVIDER_UNAVAILABLE"));
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

  checks.push(check(
    "webhook_secret",
    Boolean(row.webhook_secret_ciphertext),
    "CHECKOUT_PROVIDER_UNAVAILABLE",
  ));

  const email = await emailDeliveryReadiness(db, options.env, row.instance_id);
  checks.push(check(
    "email_integration",
    email.integrationReady,
    "CHECKOUT_NOTIFICATION_UNAVAILABLE",
    email.integrationId ? { integrationId: email.integrationId } : undefined,
  ));
  checks.push(check(
    "email_provider_credential",
    email.credentialReady,
    "CHECKOUT_NOTIFICATION_UNAVAILABLE",
    email.credentialReady ? undefined : { errorCode: email.credentialErrorCode ?? "EMAIL_INTEGRATION_NOT_CONFIGURED" },
  ));
  checks.push(check(
    "email_template_bindings",
    email.bindingsReady,
    "CHECKOUT_NOTIFICATION_UNAVAILABLE",
    {
      requiredCount: OFFER_ACTIVATION_EMAIL_CONTRACTS.length,
      activeCount: email.activeBindingCount,
    },
  ));
  const processingReady = await processingBacklogHealthy(db, row.instance_id, now);
  checks.push(check("processing_backlog", processingReady, "CHECKOUT_PROCESSING_UNAVAILABLE"));

  let signingKeyReady = true;
  if (row.credential_mode === "signed") {
    const key = await db.prepare(
      `SELECT id FROM signing_keys
       WHERE instance_id = ?1 AND product_id = ?2 AND status = 'active'
       LIMIT 1`,
    ).bind(row.instance_id, row.product_id).first<{ id: string }>();
    signingKeyReady = Boolean(key);
  }
  checks.push(check("signing_key", signingKeyReady, "CHECKOUT_CONFIGURATION_PENDING"));

  if (!options.activation) {
    checks.push(check("offer_status", row.offer_status === "active", "NO_ACTIVE_OFFER"));
  }

  const publicReasonCodes = [...new Set(
    checks.filter((item) => item.status !== "ready" && item.reasonCode).map((item) => item.reasonCode!),
  )];
  return { ready: publicReasonCodes.length === 0, publicReasonCodes, checks };
}
