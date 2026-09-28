import { requiredPaddleEventTypes } from "../../infra/billing/types";
import type { BillingProviderRecord, PaddleSupportedEventType } from "../../infra/billing/types";

export interface PaddleWebhookRequirements {
  requiredEventTypes: PaddleSupportedEventType[];
  verifiedEventTypes: PaddleSupportedEventType[];
  missingEventTypes: PaddleSupportedEventType[];
  includesSubscriptionOffers: boolean;
  apiKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  completedAt: string | null;
}

export async function getPaddleWebhookRequirements(
  db: D1Database,
  provider: Pick<
    BillingProviderRecord,
    | "id"
    | "instance_id"
    | "api_secret_ciphertext"
    | "webhook_secret_ciphertext"
    | "simulator_webhook_secret_version"
  >,
): Promise<PaddleWebhookRequirements> {
  const subscriptionOffer = await db.prepare(
    `SELECT 1 AS configured
     FROM billing_offers
     WHERE instance_id = ?1
       AND billing_provider_id = ?2
       AND purchase_type = 'subscription'
       AND status <> 'archived'
     LIMIT 1`,
  ).bind(provider.instance_id, provider.id).all<{ configured: number }>();
  const includesSubscriptionOffers = subscriptionOffer.results.length > 0;
  const apiKeyConfigured = Boolean(provider.api_secret_ciphertext);
  const requiredEventTypes = requiredPaddleEventTypes({
    includesSubscriptionOffers,
  });
  const evidence = await db.prepare(
    `SELECT event_type, verified_at
     FROM billing_webhook_simulation_tests
     WHERE instance_id = ?1
       AND billing_provider_id = ?2
       AND simulator_webhook_secret_version = ?3`,
  ).bind(
    provider.instance_id,
    provider.id,
    provider.simulator_webhook_secret_version,
  ).all<{ event_type: PaddleSupportedEventType; verified_at: string }>();
  const verified = new Map(evidence.results.map((row) => [row.event_type, row.verified_at]));
  const verifiedEventTypes = requiredEventTypes.filter((eventType) => verified.has(eventType));
  const missingEventTypes = requiredEventTypes.filter((eventType) => !verified.has(eventType));
  const webhookSecretConfigured = Boolean(provider.webhook_secret_ciphertext);
  const completedAt = webhookSecretConfigured && missingEventTypes.length === 0
    ? verifiedEventTypes.reduce<string | null>((latest, eventType) => {
        const verifiedAt = verified.get(eventType) ?? null;
        return !latest || (verifiedAt && verifiedAt > latest) ? verifiedAt : latest;
      }, null)
    : null;
  return {
    requiredEventTypes,
    verifiedEventTypes,
    missingEventTypes,
    includesSubscriptionOffers,
    apiKeyConfigured,
    webhookSecretConfigured,
    completedAt,
  };
}
