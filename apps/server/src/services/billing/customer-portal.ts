import { AppError, NotFoundError } from "../../middleware/error";
import { BillingProcessingError, PaddleHttpError } from "../../infra/billing/errors";
import { createPaddleCustomerPortalSession } from "../../infra/billing/paddle";
import { getBillingProvider } from "./customer-sync";
import { recordProviderSystemIssue } from "./system-issues";

interface PortalSessionRow {
  billing_provider_id: string;
  external_customer_id: string;
  external_subscription_id: string;
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
    `SELECT provider.id AS billing_provider_id, subscription.external_customer_id,
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
  const provider = await getBillingProvider(input.db, input.accountId, row.billing_provider_id);
  if (!provider || provider.provider !== "paddle" || provider.status !== "active") {
    throw new NotFoundError("Billing Provider was not found or is disabled.");
  }
  try {
    const session = await createPaddleCustomerPortalSession(
      provider,
      row.external_customer_id,
      row.external_subscription_id,
      input.env,
      input.fetchImpl,
      input.now,
    );
    return { url: session.url, expiresAt: session.expiresAt, providerRequestId: session.requestId };
  } catch (error) {
    if (error instanceof PaddleHttpError && error.code === "BILLING_PROVIDER_API_AUTH_INVALID") {
      await recordProviderSystemIssue({
        db: input.db,
        accountId: input.accountId,
        billingProviderId: provider.id,
        capability: "customer_portal_session",
        issueCode: error.code,
        providerError: error.providerDetails,
        now: input.now,
      });
    }
    if (error instanceof PaddleHttpError) {
      throw new AppError(
        error.code,
        "Paddle customer portal request failed.",
        502,
        {
          provider: "paddle",
          billingProviderId: provider.id,
          capability: "customer_portal_session",
          httpStatus: error.providerDetails.httpStatus,
          providerCode: error.providerDetails.providerCode,
          requestId: error.providerDetails.requestId,
          retryAfter: error.providerDetails.retryAfter,
        },
        { provider: error.providerDetails },
      );
    }
    if (error instanceof BillingProcessingError) {
      throw new AppError(error.code, error.message, error.disposition === "failed" ? 409 : 502, error.details);
    }
    throw new AppError(
      "BILLING_CUSTOMER_PORTAL_PROVIDER_ERROR",
      "Paddle customer portal request failed.",
      502,
      { provider: "paddle", billingProviderId: row.billing_provider_id },
      { providerError: error instanceof Error ? error.message : String(error) },
    );
  }
}
