import { dispatchDelivery } from "../../infra/delivery/dispatcher";
import type { DeliveryCryptoEnv } from "../../infra/delivery/crypto";

interface SchedulerEnv extends DeliveryCryptoEnv {
  DB: D1Database;
}

interface IdRow { id: string }

export async function runDeliveryScheduler(
  env: SchedulerEnv,
  options: { instanceLimit?: number; deliveryLimitPerInstance?: number; now?: Date } = {},
): Promise<{ instances: number; claimed: number; accepted: number; failed: number }> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const instancePageSize = Math.min(500, Math.max(1, options.instanceLimit ?? 100));
  const deliveryLimit = Math.min(100, Math.max(1, options.deliveryLimitPerInstance ?? 25));
  let instanceCursor: string | null = null;
  let instanceCount = 0;
  let claimed = 0;
  let accepted = 0;
  let failed = 0;

  while (true) {
    const instances: D1Result<IdRow> = await env.DB
      .prepare(
        `SELECT instance.id
         FROM instances AS instance
         WHERE instance.status = 'active'
           AND (?2 IS NULL OR instance.id > ?2)
           AND EXISTS (
             SELECT 1 FROM email_deliveries AS delivery
             WHERE delivery.instance_id = instance.id
               AND delivery.variables_ciphertext IS NOT NULL
               AND (
                 (delivery.status NOT IN ('accepted', 'expired', 'cancelled')
                   AND delivery.send_expires_at IS NOT NULL
                   AND delivery.send_expires_at <= ?1
                   AND (delivery.status <> 'processing' OR delivery.locked_until <= ?1))
                 OR (delivery.status IN ('pending', 'retry_scheduled')
                   AND (delivery.send_expires_at IS NULL OR delivery.send_expires_at > ?1)
                   AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= ?1))
                 OR (delivery.status = 'processing' AND delivery.locked_until <= ?1
                   AND (delivery.send_expires_at IS NULL OR delivery.send_expires_at > ?1))
               )
           )
         ORDER BY instance.id
         LIMIT ?3`,
      )
      .bind(nowIso, instanceCursor, instancePageSize)
      .all<IdRow>();
    if (instances.results.length === 0) break;
    instanceCount += instances.results.length;

    for (const instance of instances.results) {
      const due = await env.DB
        .prepare(
          `SELECT id
           FROM email_deliveries
           WHERE instance_id = ?1
             AND variables_ciphertext IS NOT NULL
             AND (
               (status NOT IN ('accepted', 'expired', 'cancelled')
                 AND send_expires_at IS NOT NULL AND send_expires_at <= ?2
                 AND (status <> 'processing' OR locked_until <= ?2))
               OR (status IN ('pending', 'retry_scheduled')
                 AND (send_expires_at IS NULL OR send_expires_at > ?2)
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?2))
               OR (status = 'processing' AND locked_until <= ?2
                 AND (send_expires_at IS NULL OR send_expires_at > ?2))
             )
           ORDER BY created_at, id
           LIMIT ?3`,
        )
        .bind(instance.id, nowIso, deliveryLimit)
        .all<IdRow>();
      for (const delivery of due.results) {
        const result = await dispatchDelivery({
          db: env.DB,
          env,
          instanceId: instance.id,
          deliveryId: delivery.id,
          now,
        });
        if (result.claimed) claimed++;
        if (result.status === "accepted") accepted++;
        if (result.status === "failed") failed++;
      }
    }

    instanceCursor = instances.results[instances.results.length - 1].id;
  }

  return { instances: instanceCount, claimed, accepted, failed };
}
