import { dispatchDelivery } from "../../infra/delivery/dispatcher";
import type { DeliveryCryptoEnv } from "../../infra/delivery/crypto";

interface SchedulerEnv extends DeliveryCryptoEnv {
  DB: D1Database;
}

interface IdRow { id: string }

export async function runDeliveryScheduler(
  env: SchedulerEnv,
  options: { accountLimit?: number; deliveryLimitPerAccount?: number; now?: Date } = {}
): Promise<{ accounts: number; claimed: number; accepted: number; failed: number }> {
  const now = options.now ?? new Date();
  const accountPageSize = Math.min(500, Math.max(1, options.accountLimit ?? 100));
  const deliveryLimit = Math.min(100, Math.max(1, options.deliveryLimitPerAccount ?? 25));
  const nowIso = now.toISOString();
  let accountCursor: string | null = null;
  let accountCount = 0;
  let claimed = 0;
  let accepted = 0;
  let failed = 0;

  while (true) {
    const accounts: D1Result<IdRow> = await env.DB
      .prepare(
        `SELECT account.id
         FROM accounts AS account
         WHERE account.status = 'active'
           AND (?2 IS NULL OR account.id > ?2)
           AND EXISTS (
             SELECT 1 FROM outbound_deliveries AS delivery
             WHERE delivery.account_id = account.id
               AND delivery.payload_ciphertext IS NOT NULL
               AND (
                 (delivery.status IN ('pending', 'retry_scheduled')
                   AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= ?1))
                 OR (delivery.status = 'processing' AND delivery.locked_until <= ?1)
                 OR (delivery.status NOT IN ('accepted', 'payload_expired')
                   AND delivery.payload_expires_at <= ?1)
               )
           )
         ORDER BY account.id
         LIMIT ?3`
      )
      .bind(nowIso, accountCursor, accountPageSize)
      .all<IdRow>();

    if (accounts.results.length === 0) break;
    accountCount += accounts.results.length;

    for (const account of accounts.results) {
      const due = await env.DB
        .prepare(
          `SELECT id FROM outbound_deliveries
           WHERE account_id = ?1
             AND payload_ciphertext IS NOT NULL
             AND (
               (status IN ('pending', 'retry_scheduled') AND (next_attempt_at IS NULL OR next_attempt_at <= ?2))
               OR (status = 'processing' AND locked_until <= ?2)
               OR (status NOT IN ('accepted', 'payload_expired') AND payload_expires_at <= ?2)
             )
           ORDER BY created_at, id
           LIMIT ?3`
        )
        .bind(account.id, nowIso, deliveryLimit)
        .all<IdRow>();
      for (const delivery of due.results) {
        const result = await dispatchDelivery({
          db: env.DB,
          env,
          accountId: account.id,
          deliveryId: delivery.id,
          now,
        });
        if (result.claimed) claimed++;
        if (result.status === "accepted") accepted++;
        if (result.status === "failed") failed++;
      }
    }

    accountCursor = accounts.results[accounts.results.length - 1].id;
  }

  return { accounts: accountCount, claimed, accepted, failed };
}
