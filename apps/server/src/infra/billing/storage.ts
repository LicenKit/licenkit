import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../delivery/crypto";
import type { BillingProviderRecord } from "./types";

export interface BillingCryptoEnv {
  STORAGE_ENCRYPTION_KEY?: string;
  STORAGE_ENCRYPTION_KEY_ID?: string;
}

export function encryptBillingProviderSecret(
  plaintext: string,
  env: BillingCryptoEnv,
  instanceId: string,
  providerId: string,
  field: "webhook_secret_ciphertext" | "simulator_webhook_secret_ciphertext" | "api_secret_ciphertext",
): Promise<string> {
  return encryptEnvelopeV1(plaintext, env, {
    instanceId,
    table: "billing_providers",
    rowId: providerId,
    field,
  });
}

export function decryptBillingProviderSimulatorWebhookSecret(
  provider: BillingProviderRecord,
  env: BillingCryptoEnv,
): Promise<string> {
  if (!provider.simulator_webhook_secret_ciphertext) {
    return Promise.reject(new Error("Paddle Simulator webhook secret is not configured."));
  }
  return decryptEnvelopeV1(provider.simulator_webhook_secret_ciphertext, env, {
    instanceId: provider.instance_id,
    table: "billing_providers",
    rowId: provider.id,
    field: "simulator_webhook_secret_ciphertext",
  });
}

export function decryptBillingProviderWebhookSecret(
  provider: BillingProviderRecord,
  env: BillingCryptoEnv,
): Promise<string> {
  return decryptEnvelopeV1(provider.webhook_secret_ciphertext, env, {
    instanceId: provider.instance_id,
    table: "billing_providers",
    rowId: provider.id,
    field: "webhook_secret_ciphertext",
  });
}

export function encryptInboundPayload(
  plaintext: string,
  env: BillingCryptoEnv,
  instanceId: string,
  eventId: string,
): Promise<string> {
  return encryptEnvelopeV1(plaintext, env, {
    instanceId,
    table: "inbound_events",
    rowId: eventId,
    field: "payload_ciphertext",
  });
}

export function decryptInboundPayload(
  ciphertext: string,
  env: BillingCryptoEnv,
  instanceId: string,
  eventId: string,
): Promise<string> {
  return decryptEnvelopeV1(ciphertext, env, {
    instanceId,
    table: "inbound_events",
    rowId: eventId,
    field: "payload_ciphertext",
  });
}
