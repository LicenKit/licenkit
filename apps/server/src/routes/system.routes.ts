import { Hono } from "hono";
import type { AppContext } from "../types";
import { AppError } from "../middleware/error";
import { readSchedulerHealth } from "../services/runtime/scheduler-health";

export const systemRouter = new Hono<AppContext>();

systemRouter.get("/status", async (c) => {
  const result = await c.env.DB
    .prepare(
      `SELECT instance_name, app_url, api_base_url, initialized_at
       FROM system_settings WHERE id = 'current' LIMIT 1`,
    )
    .all<{
      instance_name: string;
      app_url: string;
      api_base_url: string | null;
      initialized_at: string;
    }>();
  const settings = result.results[0];
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: settings
      ? {
          initialized: true,
          instanceName: settings.instance_name,
          appUrl: settings.app_url,
          apiBaseUrl: settings.api_base_url ?? settings.app_url,
          initializedAt: settings.initialized_at,
          version: c.env.APP_VERSION || "1.0.0",
        }
      : { initialized: false, version: c.env.APP_VERSION || "1.0.0" },
  });
});

interface ReadinessRow {
  initialized: number;
  pending_events: number;
  needs_attention_events: number;
  pending_deliveries: number;
  blocked_deliveries: number;
  active_providers: number;
  active_notification_gateways: number;
}

systemRouter.get("/readiness", async (c) => {
  const now = new Date().toISOString();
  let row: ReadinessRow | undefined;
  try {
    const result = await c.env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM system_settings WHERE id = 'current') AS initialized,
           (SELECT COUNT(*) FROM inbound_events WHERE status IN ('pending', 'processing')) AS pending_events,
           (SELECT COUNT(*) FROM inbound_events WHERE status = 'needs_attention') AS needs_attention_events,
           (SELECT COUNT(*) FROM outbound_deliveries WHERE status IN ('pending', 'processing', 'retry_scheduled')) AS pending_deliveries,
           (SELECT COUNT(*) FROM outbound_deliveries WHERE status IN ('blocked_configuration', 'failed', 'payload_expired')) AS blocked_deliveries,
           (SELECT COUNT(*) FROM billing_providers WHERE status = 'active') AS active_providers,
           (SELECT COUNT(*) FROM outbound_endpoints WHERE endpoint_type = 'notification_gateway' AND status = 'active') AS active_notification_gateways`,
      )
      .all<ReadinessRow>();
    row = result.results[0];
  } catch (error) {
    throw new AppError(
      "READINESS_DATABASE_UNAVAILABLE",
      "D1 readiness query failed.",
      503,
      { checked_at: now },
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  let schedulerHealth;
  try {
    schedulerHealth = await readSchedulerHealth(c.env.DB, new Date(now));
  } catch (error) {
    throw new AppError(
      "READINESS_SCHEDULER_STATE_UNAVAILABLE",
      "Scheduled Worker health state could not be read.",
      503,
      { checked_at: now },
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const storageKeyReady = Boolean(c.env.STORAGE_ENCRYPTION_KEY?.trim());
  const turnstileSiteKey = c.env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const turnstileSecretKey = c.env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  const turnstileReady = Boolean(
    turnstileSiteKey
    && turnstileSecretKey
    && !turnstileSiteKey.startsWith("replace-with-")
    && !turnstileSecretKey.startsWith("replace-with-"),
  );
  const initialized = Number(row?.initialized || 0) === 1;
  const ready = initialized && storageKeyReady && turnstileReady && schedulerHealth.ready;
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      success: true,
      data: {
        ready,
        checkedAt: now,
        checks: {
          database: "ready",
          initialized: initialized ? "ready" : "not_ready",
          storageEncryptionKey: storageKeyReady ? "ready" : "not_ready",
          turnstileConfiguration: turnstileReady ? "ready" : "not_ready",
          schedulerLastSuccess: schedulerHealth.ready ? "ready" : "not_ready",
        },
        scheduler: schedulerHealth.record,
        backlog: {
          pendingInboundEvents: Number(row?.pending_events || 0),
          needsAttentionInboundEvents: Number(row?.needs_attention_events || 0),
          pendingDeliveries: Number(row?.pending_deliveries || 0),
          blockedDeliveries: Number(row?.blocked_deliveries || 0),
        },
        capabilities: {
          activeBillingProviders: Number(row?.active_providers || 0),
          activeNotificationGateways: Number(row?.active_notification_gateways || 0),
        },
      },
    },
    ready ? 200 : 503,
  );
});
