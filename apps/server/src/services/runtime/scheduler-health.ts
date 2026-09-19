export const SCHEDULER_HEALTH_KEY = "runtime:scheduled-worker:last-success";
export const SCHEDULER_STALE_AFTER_MS = 3 * 60_000;

export interface SchedulerHealthRecord {
  completedAt: string;
  durationMs: number;
}

export async function recordSchedulerSuccess(
  store: KVNamespace,
  startedAtMs: number,
  completedAt = new Date(),
): Promise<SchedulerHealthRecord> {
  const record = {
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - startedAtMs),
  };
  await store.put(SCHEDULER_HEALTH_KEY, JSON.stringify(record), { expirationTtl: 7 * 24 * 60 * 60 });
  return record;
}

export async function readSchedulerHealth(
  store: KVNamespace,
  now = new Date(),
): Promise<{ ready: boolean; record: SchedulerHealthRecord | null }> {
  const raw = await store.get(SCHEDULER_HEALTH_KEY);
  if (!raw) return { ready: false, record: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`SCHEDULER_HEALTH_INVALID_JSON:${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !parsed || typeof parsed !== "object" ||
    typeof (parsed as any).completedAt !== "string" ||
    typeof (parsed as any).durationMs !== "number" ||
    !Number.isFinite(Date.parse((parsed as any).completedAt)) ||
    !Number.isFinite((parsed as any).durationMs)
  ) {
    throw new Error("SCHEDULER_HEALTH_INVALID_RECORD");
  }
  const record = parsed as SchedulerHealthRecord;
  return {
    ready: now.getTime() - Date.parse(record.completedAt) <= SCHEDULER_STALE_AFTER_MS,
    record,
  };
}
