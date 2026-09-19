import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/mock-d1";
import {
  recordSchedulerSuccess,
  readSchedulerHealth,
} from "../src/services/runtime/scheduler-health";

describe("V1 Scheduled Worker health evidence", () => {
  it("reports a recent successful run and its duration", async () => {
    const { env } = createTestEnv();
    const completedAt = new Date("2026-09-19T12:00:01.000Z");
    await recordSchedulerSuccess(env.KEYS_KV, completedAt.getTime() - 1_250, completedAt);
    await expect(readSchedulerHealth(env.KEYS_KV, new Date("2026-09-19T12:02:00.000Z")))
      .resolves.toEqual({
        ready: true,
        record: { completedAt: completedAt.toISOString(), durationMs: 1_250 },
      });
  });

  it("fails closed when evidence is missing or stale", async () => {
    const { env } = createTestEnv();
    await expect(readSchedulerHealth(env.KEYS_KV, new Date())).resolves.toEqual({ ready: false, record: null });
    const completedAt = new Date("2026-09-19T12:00:00.000Z");
    await recordSchedulerSuccess(env.KEYS_KV, completedAt.getTime(), completedAt);
    await expect(readSchedulerHealth(env.KEYS_KV, new Date("2026-09-19T12:04:00.000Z")))
      .resolves.toMatchObject({ ready: false });
  });
});
