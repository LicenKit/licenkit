export const SCHEDULER_STALE_AFTER_MS = 3 * 60_000;

export interface SchedulerHealthRecord {
  completedAt: string;
  durationMs: number;
}

export async function recordSchedulerSuccess(
  db: D1Database,
  startedAtMs: number,
  completedAt = new Date(),
): Promise<SchedulerHealthRecord> {
  const record = {
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - startedAtMs),
  };
  const result = await db.prepare(
    `UPDATE system_settings
     SET scheduler_last_success_at = ?1, scheduler_last_duration_ms = ?2
     WHERE id = 'current'`,
  ).bind(record.completedAt, record.durationMs).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("SCHEDULER_HEALTH_SETTINGS_NOT_INITIALIZED");
  }
  return record;
}

export async function readSchedulerHealth(
  db: D1Database,
  now = new Date(),
): Promise<{ ready: boolean; record: SchedulerHealthRecord | null }> {
  const result = await db.prepare(
    `SELECT scheduler_last_success_at, scheduler_last_duration_ms
     FROM system_settings WHERE id = 'current' LIMIT 1`,
  ).all<{ scheduler_last_success_at: string | null; scheduler_last_duration_ms: number | null }>();
  const row = result.results[0];
  if (!row || (row.scheduler_last_success_at === null && row.scheduler_last_duration_ms === null)) {
    return { ready: false, record: null };
  }
  if (
    typeof row.scheduler_last_success_at !== "string" ||
    typeof row.scheduler_last_duration_ms !== "number" ||
    !Number.isFinite(Date.parse(row.scheduler_last_success_at)) ||
    !Number.isFinite(row.scheduler_last_duration_ms) ||
    row.scheduler_last_duration_ms < 0
  ) {
    throw new Error("SCHEDULER_HEALTH_INVALID_RECORD");
  }
  const record: SchedulerHealthRecord = {
    completedAt: row.scheduler_last_success_at,
    durationMs: row.scheduler_last_duration_ms,
  };
  const ageMs = now.getTime() - Date.parse(record.completedAt);
  return {
    ready: ageMs >= 0 && ageMs <= SCHEDULER_STALE_AFTER_MS,
    record,
  };
}
