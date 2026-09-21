import { Hono } from "hono";
import type { AppContext } from "../../types";
import { requireRole } from "../../middleware/auth";

export const adminStatsRouter = new Hono<AppContext>();

// GET /api/v1/admin/stats
adminStatsRouter.get("/", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const accountId = c.get("accountId")!;
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 86400 * 1000).toISOString();
  const result = await c.env.DB
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE account_id = ?1 AND status = 'active') AS total_products,
         (SELECT COUNT(*) FROM licenses WHERE account_id = ?1) AS total_licenses,
         (SELECT COUNT(*) FROM activations WHERE account_id = ?1 AND status = 'active') AS active_activations,
         (SELECT COUNT(*) FROM licenses
            WHERE account_id = ?1 AND status = 'active'
              AND expires_at >= ?2 AND expires_at <= ?3) AS expiring_soon,
         (SELECT COUNT(*) FROM inbound_events
            WHERE account_id = ?1 AND status IN ('pending', 'processing', 'needs_attention')) AS pending_inbound_events,
         (SELECT COUNT(*) FROM email_deliveries
            WHERE account_id = ?1 AND status IN ('pending', 'processing', 'retry_scheduled', 'waiting_configuration', 'failed')) AS pending_deliveries`
    )
    .bind(accountId, now.toISOString(), in30Days)
    .all<{
      total_products: number;
      total_licenses: number;
      active_activations: number;
      expiring_soon: number;
      pending_inbound_events: number;
      pending_deliveries: number;
    }>();
  const row = result.results[0];

  return c.json({
    success: true,
    data: {
      totalProducts: Number(row?.total_products || 0),
      totalLicenses: Number(row?.total_licenses || 0),
      activeActivations: Number(row?.active_activations || 0),
      expiringSoon: Number(row?.expiring_soon || 0),
      pendingInboundEvents: Number(row?.pending_inbound_events || 0),
      pendingDeliveries: Number(row?.pending_deliveries || 0),
    },
  });
});
