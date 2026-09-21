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
  const nowIso = now.toISOString();
  let cursor = "";
  let cleared = 0;
  while (true) {
    const instances = await db.prepare(
      `SELECT instance.id
       FROM instances AS instance
       WHERE instance.status = 'active' AND instance.id > ?1
         AND EXISTS (
           SELECT 1 FROM email_deliveries AS delivery
           WHERE delivery.instance_id = instance.id
             AND delivery.status = 'accepted'
             AND delivery.variables_ciphertext IS NOT NULL
             AND delivery.variables_expires_at IS NOT NULL
             AND delivery.variables_expires_at <= ?2
         )
       ORDER BY instance.id
       LIMIT 100`,
    ).bind(cursor, nowIso).all<{ id: string }>();
    if (instances.results.length === 0) break;
    for (const instance of instances.results) {
      const result = await db.prepare(
        `UPDATE email_deliveries
         SET variables_ciphertext = NULL, updated_at = ?1
         WHERE instance_id = ?2
           AND status = 'accepted'
           AND variables_ciphertext IS NOT NULL
           AND variables_expires_at IS NOT NULL
           AND variables_expires_at <= ?1`,
      ).bind(nowIso, instance.id).run();
      cleared += Number(result.meta?.changes ?? 0);
    }
    cursor = instances.results[instances.results.length - 1].id;
  }
  return cleared;
}
