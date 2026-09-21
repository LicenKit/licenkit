export async function clearExpiredInboundEventPayloads(
  db: D1Database,
  options: { now?: Date; limit?: number; instanceLimit?: number } = {},
): Promise<{ cleared: number }> {
  const nowIso = (options.now ?? new Date()).toISOString();
  const limit = Math.min(1_000, Math.max(1, options.limit ?? 500));
  const instanceLimit = Math.min(500, Math.max(1, options.instanceLimit ?? 100));
  let cursor = "";
  let cleared = 0;
  while (true) {
    const instances = await db.prepare(
      `SELECT instance.id
       FROM instances AS instance
       WHERE instance.status = 'active' AND instance.id > ?1
         AND EXISTS (
           SELECT 1 FROM inbound_events AS event
           WHERE event.instance_id = instance.id
             AND event.payload_ciphertext IS NOT NULL
             AND event.payload_expires_at <= ?2
         )
       ORDER BY instance.id
       LIMIT ?3`,
    ).bind(cursor, nowIso, instanceLimit).all<{ id: string }>();
    if (instances.results.length === 0) break;
    for (const instance of instances.results) {
      const result = await db.prepare(
        `UPDATE inbound_events
         SET payload_ciphertext = NULL,
             payload_cleared_at = COALESCE(payload_cleared_at, ?1),
             updated_at = ?1
         WHERE instance_id = ?2
           AND id IN (
             SELECT id
             FROM inbound_events
             WHERE instance_id = ?2
               AND payload_ciphertext IS NOT NULL
               AND payload_expires_at <= ?1
             ORDER BY payload_expires_at, id
             LIMIT ?3
           )
           AND payload_ciphertext IS NOT NULL
           AND payload_expires_at <= ?1`,
      ).bind(nowIso, instance.id, limit).run();
      cleared += Number(result.meta?.changes ?? 0);
    }
    cursor = instances.results[instances.results.length - 1].id;
  }
  return { cleared };
}
