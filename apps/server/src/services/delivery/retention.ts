const DEFAULT_SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS = 86_400;

export interface SensitiveDeliveryRetentionEnv {
  SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS?: string | number;
}

export function sensitiveDeliveryPayloadTtlSeconds(
  value: string | number | undefined,
): number {
  if (value === undefined || value === "") {
    return DEFAULT_SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS must be a positive integer");
  }
  return parsed;
}

export function acceptedPayloadExpiration(
  now: Date,
  env: SensitiveDeliveryRetentionEnv,
): string {
  return new Date(
    now.getTime() + sensitiveDeliveryPayloadTtlSeconds(
      env.SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS,
    ) * 1000,
  ).toISOString();
}

export async function clearExpiredAcceptedEmailPayloads(
  db: D1Database,
  now: Date = new Date(),
): Promise<number> {
  const result = await db.prepare(
    `UPDATE email_deliveries
     SET variables_ciphertext = NULL, updated_at = ?1
     WHERE status = 'accepted'
       AND variables_ciphertext IS NOT NULL
       AND variables_expires_at IS NOT NULL
       AND variables_expires_at <= ?1`,
  ).bind(now.toISOString()).run();
  return Number(result.meta?.changes ?? 0);
}
