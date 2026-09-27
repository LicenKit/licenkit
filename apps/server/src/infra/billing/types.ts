export const PADDLE_ONE_TIME_EVENT_TYPES = [
  "customer.created",
  "customer.updated",
  "transaction.completed",
  "adjustment.created",
  "adjustment.updated",
] as const;

export const PADDLE_SUBSCRIPTION_EVENT_TYPES = [
  "subscription.created",
  "subscription.updated",
] as const;

export const PADDLE_SUPPORTED_EVENT_TYPES = [
  ...PADDLE_ONE_TIME_EVENT_TYPES,
  ...PADDLE_SUBSCRIPTION_EVENT_TYPES,
] as const;

export type PaddleSupportedEventType = (typeof PADDLE_SUPPORTED_EVENT_TYPES)[number];

export function requiredPaddleEventTypes(input: {
  includesSubscriptionOffers: boolean;
}): PaddleSupportedEventType[] {
  return [
    ...PADDLE_ONE_TIME_EVENT_TYPES,
    ...(input.includesSubscriptionOffers ? PADDLE_SUBSCRIPTION_EVENT_TYPES : []),
  ];
}
export type BillingEnvironment = "sandbox" | "live";
export type PurchaseType = "one_time" | "subscription";

export interface BillingProviderRecord {
  id: string;
  instance_id: string;
  provider: "paddle";
  environment: BillingEnvironment;
  client_side_token: string;
  webhook_secret_ciphertext: string;
  webhook_secret_version: number;
  simulator_webhook_secret_ciphertext: string | null;
  simulator_webhook_secret_version: number;
  api_secret_ciphertext: string | null;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface PaddleWebhookEnvelope {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface PaddleEventReferences {
  externalCustomerId: string | null;
  externalTransactionId: string | null;
  externalSubscriptionId: string | null;
  externalAdjustmentId: string | null;
}

export interface PaddleLineItem {
  priceId: string;
  quantity: number;
}

export interface ProviderHttpErrorDetails {
  provider: "paddle";
  operation: string;
  httpStatus: number | null;
  providerCode: string | null;
  requestId: string | null;
  retryAfter: string | null;
  message: string;
}

export type ReadinessCheckStatus = "ready" | "not_ready" | "stale";

export interface ReadinessCheck {
  key: string;
  status: ReadinessCheckStatus;
  reasonCode?: string;
  checkedAt?: string;
  details?: Record<string, unknown>;
}

export interface CheckoutReadiness {
  ready: boolean;
  publicReasonCodes: string[];
  checks: ReadinessCheck[];
}
