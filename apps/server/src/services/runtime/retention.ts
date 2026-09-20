export async function clearExpiredInboundEventPayloads(
  db: D1Database,
  options: { now?: Date; limit?: number } = {},
): Promise<{ cleared: number }> {
  const nowIso = (options.now ?? new Date()).toISOString();
  const limit = Math.min(1_000, Math.max(1, options.limit ?? 500));
  const result = await db.prepare(
    `UPDATE inbound_events
     SET payload_ciphertext = NULL,
         payload_cleared_at = COALESCE(payload_cleared_at, ?1),
         updated_at = ?1
     WHERE id IN (
       SELECT id
       FROM inbound_events
       WHERE payload_ciphertext IS NOT NULL AND payload_expires_at <= ?1
       ORDER BY payload_expires_at, id
       LIMIT ?2
     )
       AND payload_ciphertext IS NOT NULL AND payload_expires_at <= ?1`,
  ).bind(nowIso, limit).run();
  return { cleared: Number(result.meta?.changes ?? 0) };
}
