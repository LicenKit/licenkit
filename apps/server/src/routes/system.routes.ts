import { Hono } from "hono";
import type { AppContext } from "../types";
import { AppError } from "../middleware/error";
import {
  readDeploymentSetupState,
  type DeploymentSetupState,
} from "../services/identity/deployment-provisioning";

export const systemRouter = new Hono<AppContext>();

function inconsistentSetupState(
  state: DeploymentSetupState,
  extraDetails: Record<string, unknown> = {},
): AppError {
  return new AppError(
    "SETUP_STATE_INCONSISTENT",
    "Database initialization state is inconsistent",
    500,
    { ...state, ...extraDetails },
  );
}

systemRouter.get("/status", async (c) => {
  const setupState = await readDeploymentSetupState(c.env.DB);
  if (setupState.status === "inconsistent") throw inconsistentSetupState(setupState);
  if (setupState.status === "empty") {
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: { initialized: false, version: c.env.APP_VERSION || "1.0.0" },
    });
  }

  const result = await c.env.DB
    .prepare(
      `SELECT instance.name AS instance_name, instance.site_url AS customer_site_url,
              instance.admin_api_url,
              bootstrap.completed_at AS initialized_at
       FROM deployment_bootstrap AS bootstrap
       JOIN instances AS instance ON instance.status = 'active'
       WHERE bootstrap.singleton_key = 'deployment'
       ORDER BY instance.id
       LIMIT 1`,
    )
    .all<{
      instance_name: string;
      customer_site_url: string;
      admin_api_url: string;
      initialized_at: string;
    }>();
  const settings = result.results[0];
  if (!settings) {
    throw inconsistentSetupState(setupState, { status_row_present: false });
  }
  const adminApiUrl = settings.admin_api_url;
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: {
      initialized: true,
      instance_name: settings.instance_name,
      admin_api_url: adminApiUrl,
      customer_site_url: settings.customer_site_url,
      api_base_url: `${adminApiUrl}/api/v1`,
      initialized_at: settings.initialized_at,
      version: c.env.APP_VERSION || "1.0.0",
    },
  });
});

interface ReadinessRow {
  pending_events: number;
  needs_attention_events: number;
  pending_deliveries: number;
  blocked_deliveries: number;
  active_providers: number;
  active_email_integrations: number;
  active_email_template_bindings: number;
}

systemRouter.get("/readiness", async (c) => {
  const now = new Date().toISOString();
  let row: ReadinessRow | undefined;
  let setupState: DeploymentSetupState | undefined;
  try {
    setupState = await readDeploymentSetupState(c.env.DB);
    const result = await c.env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM inbound_events WHERE status IN ('pending', 'processing')) AS pending_events,
           (SELECT COUNT(*) FROM inbound_events WHERE status = 'needs_attention') AS needs_attention_events,
           (SELECT COUNT(*) FROM email_deliveries WHERE status IN ('pending', 'processing', 'retry_scheduled')) AS pending_deliveries,
           (SELECT COUNT(*) FROM email_deliveries WHERE status IN ('waiting_configuration', 'failed', 'expired')) AS blocked_deliveries,
           (SELECT COUNT(*) FROM billing_providers WHERE status = 'active') AS active_providers,
           (SELECT COUNT(*) FROM email_integrations WHERE status = 'active') AS active_email_integrations,
           (SELECT COUNT(*)
            FROM email_template_bindings AS binding
            JOIN email_integrations AS integration
              ON integration.instance_id = binding.instance_id
             AND integration.id = binding.email_integration_id
	            WHERE integration.status = 'active' AND binding.status = 'active') AS active_email_template_bindings`,
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

  if (setupState?.status === "inconsistent") {
    throw inconsistentSetupState(setupState);
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
  const initialized = setupState?.status === "completed";
  const ready = initialized && storageKeyReady && turnstileReady;
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      success: true,
      data: {
        ready,
        checked_at: now,
        checks: {
          database: "ready",
          initialized: initialized ? "ready" : "not_ready",
          storage_encryption_key: storageKeyReady ? "ready" : "not_ready",
          turnstile_configuration: turnstileReady ? "ready" : "not_ready",
        },
        backlog: {
          pending_inbound_events: Number(row?.pending_events || 0),
          needs_attention_inbound_events: Number(row?.needs_attention_events || 0),
          pending_deliveries: Number(row?.pending_deliveries || 0),
          blocked_deliveries: Number(row?.blocked_deliveries || 0),
        },
        capabilities: {
          active_billing_providers: Number(row?.active_providers || 0),
          active_email_integrations: Number(row?.active_email_integrations || 0),
          active_email_template_bindings: Number(row?.active_email_template_bindings || 0),
        },
      },
    },
    ready ? 200 : 503,
  );
});
