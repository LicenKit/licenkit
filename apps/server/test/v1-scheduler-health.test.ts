import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/mock-d1";
import {
  recordSchedulerSuccess,
  readSchedulerHealth,
} from "../src/services/runtime/scheduler-health";

describe("V1 Scheduled Worker health evidence", () => {
  async function initializeSettings(env: ReturnType<typeof createTestEnv>["env"]) {
    await env.DB.prepare(
      `INSERT INTO system_settings (
         id, instance_name, app_url, api_base_url, initialized_at, updated_at
       ) VALUES ('current', 'LicenKit', 'https://license.example', NULL, ?1, ?1)`,
    ).bind("2026-09-19T11:00:00.000Z").run();
  }

  it("reports a recent successful run and its duration", async () => {
    const { env } = createTestEnv();
    await initializeSettings(env);
    const completedAt = new Date("2026-09-19T12:00:01.000Z");
    await recordSchedulerSuccess(env.DB, completedAt.getTime() - 1_250, completedAt);
    await expect(readSchedulerHealth(env.DB, new Date("2026-09-19T12:02:00.000Z")))
      .resolves.toEqual({
        ready: true,
        record: { completedAt: completedAt.toISOString(), durationMs: 1_250 },
      });
  });

  it("fails closed when evidence is missing or stale", async () => {
    const { env } = createTestEnv();
    await initializeSettings(env);
    await expect(readSchedulerHealth(env.DB, new Date())).resolves.toEqual({ ready: false, record: null });
    const completedAt = new Date("2026-09-19T12:00:00.000Z");
    await recordSchedulerSuccess(env.DB, completedAt.getTime(), completedAt);
    await expect(readSchedulerHealth(env.DB, new Date("2026-09-19T12:04:00.000Z")))
      .resolves.toMatchObject({ ready: false });
  });

  it("rejects a success heartbeat before the singleton setup row exists", async () => {
    const { env } = createTestEnv();
    await expect(recordSchedulerSuccess(env.DB, Date.now())).rejects.toThrow(
      "SCHEDULER_HEALTH_SETTINGS_NOT_INITIALIZED",
    );
  });
});
