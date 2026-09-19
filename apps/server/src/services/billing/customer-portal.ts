import { decryptEnvelopeV1 } from "../../infra/delivery/crypto";
import { AppError, NotFoundError } from "../../middleware/error";
import { serializeBillingDiagnostic } from "../../infra/billing/redaction";

interface PortalSessionRow {
  billing_provider_id: string;
  environment: "sandbox" | "live";
  api_secret_ciphertext: string | null;
  external_customer_id: string;
  external_subscription_id: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function apiBase(environment: "sandbox" | "live"): string {
  return environment === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
}

/** Creates a provider-hosted portal URL. It never mutates local subscription state. */
export async function createCustomerPortalSession(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string; STORAGE_ENCRYPTION_KEY_ID?: string };
  accountId: string;
  customerId: string;
  licenseId: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{ url: string; expiresAt: string; providerRequestId: string | null }> {
  const row = await input.db.prepare(
    `SELECT provider.id AS billing_provider_id, provider.environment,
            provider.api_secret_ciphertext, subscription.external_customer_id,
            subscription.external_subscription_id
     FROM licenses AS license
     JOIN billing_subscriptions AS subscription
       ON subscription.account_id = license.account_id AND subscription.license_id = license.id
     JOIN billing_providers AS provider
       ON provider.account_id = subscription.account_id
      AND provider.id = subscription.billing_provider_id
     JOIN billing_customers AS billing_customer
       ON billing_customer.account_id = subscription.account_id
      AND billing_customer.billing_provider_id = subscription.billing_provider_id
      AND billing_customer.external_customer_id = subscription.external_customer_id
     WHERE license.account_id = ?1 AND license.customer_id = ?2 AND license.id = ?3
       AND license.renewal_mode = 'billing'
       AND provider.provider = 'paddle' AND provider.status = 'active'
       AND billing_customer.customer_id = ?2
     LIMIT 1`,
  ).bind(input.accountId, input.customerId, input.licenseId).first<PortalSessionRow>();
  if (!row) throw new NotFoundError("Billing-managed Customer subscription was not found.");
  if (!row.api_secret_ciphertext) {
    throw new AppError(
      "BILLING_CUSTOMER_PORTAL_NOT_CONFIGURED",
      "Paddle customer portal capability is not configured for this Provider.",
      409,
      { billingProviderId: row.billing_provider_id, capability: "customer_portal_session.write" },
    );
  }
  const apiKey = await decryptEnvelopeV1(row.api_secret_ciphertext, input.env, {
    accountId: input.accountId,
    table: "billing_providers",
    rowId: row.billing_provider_id,
    field: "api_secret_ciphertext",
  });
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `${apiBase(row.environment)}/customers/${encodeURIComponent(row.external_customer_id)}/portal-sessions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Paddle-Version": "1",
        },
        body: JSON.stringify({ subscription_ids: [row.external_subscription_id] }),
      },
    );
  } catch (error) {
    throw new AppError(
      "BILLING_CUSTOMER_PORTAL_PROVIDER_ERROR",
      "Paddle customer portal request failed.",
      502,
      { provider: "paddle", billingProviderId: row.billing_provider_id },
      { providerError: error instanceof Error ? error.message : String(error) },
    );
  }
  const requestId = response.headers.get("request-id");
  let body: Record<string, unknown> = {};
  try {
    body = asObject(await response.json());
  } catch {
    body = {};
  }
  if (!response.ok) {
    const providerError = asObject(body.error);
    throw new AppError(
      "BILLING_CUSTOMER_PORTAL_PROVIDER_ERROR",
      "Paddle rejected the customer portal session request.",
      502,
      {
        provider: "paddle",
        billingProviderId: row.billing_provider_id,
        httpStatus: response.status,
        providerCode: typeof providerError.code === "string" ? providerError.code : null,
        requestId,
      },
      { provider: serializeBillingDiagnostic(providerError) },
    );
  }
  const data = asObject(body.data);
  const urls = asObject(data.urls);
  const general = asObject(urls.general);
  const url = typeof general.overview === "string" ? general.overview : null;
  if (!url || !url.startsWith("https://")) {
    throw new AppError(
      "BILLING_CUSTOMER_PORTAL_RESPONSE_INVALID",
      "Paddle did not return a valid hosted customer portal URL.",
      502,
      { provider: "paddle", billingProviderId: row.billing_provider_id, requestId },
    );
  }
  const providerExpiresAt = typeof data.expires_at === "string" && Number.isFinite(Date.parse(data.expires_at))
    ? new Date(data.expires_at).toISOString()
    : new Date((input.now ?? new Date()).getTime() + 15 * 60_000).toISOString();
  return { url, expiresAt: providerExpiresAt, providerRequestId: requestId };
}

