import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../delivery/crypto";
import type { BillingProviderRecord } from "./types";

export interface BillingCryptoEnv {
  STORAGE_ENCRYPTION_KEY?: string;
  STORAGE_ENCRYPTION_KEY_ID?: string;
}

export function encryptBillingProviderSecret(
  plaintext: string,
  env: BillingCryptoEnv,
  accountId: string,
  providerId: string,
  field: "webhook_secret_ciphertext" | "api_secret_ciphertext",
): Promise<string> {
  return encryptEnvelopeV1(plaintext, env, {
    accountId,
    table: "billing_providers",
    rowId: providerId,
    field,
  });
}

export function decryptBillingProviderWebhookSecret(
  provider: BillingProviderRecord,
  env: BillingCryptoEnv,
): Promise<string> {
  return decryptEnvelopeV1(provider.webhook_secret_ciphertext, env, {
    accountId: provider.account_id,
    table: "billing_providers",
    rowId: provider.id,
    field: "webhook_secret_ciphertext",
  });
}

export function encryptInboundPayload(
  plaintext: string,
  env: BillingCryptoEnv,
  accountId: string,
  eventId: string,
): Promise<string> {
  return encryptEnvelopeV1(plaintext, env, {
    accountId,
    table: "inbound_events",
    rowId: eventId,
    field: "payload_ciphertext",
  });
}

export function decryptInboundPayload(
  ciphertext: string,
  env: BillingCryptoEnv,
  accountId: string,
  eventId: string,
): Promise<string> {
  return decryptEnvelopeV1(ciphertext, env, {
    accountId,
    table: "inbound_events",
    rowId: eventId,
    field: "payload_ciphertext",
  });
}
