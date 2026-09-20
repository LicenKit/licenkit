import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../types";
import { AppError, NotFoundError } from "../middleware/error";
import {
  customerCsrf,
  customerSessionAuth,
  requireExactOrigin,
} from "../middleware/auth";
import { dispatchDelivery } from "../infra/delivery/dispatcher";
import { rotateLicenseKey } from "../services/license/key-rotation";
import { prepareAuditInsert } from "../services/identity/audit";
import { positiveIntegerSetting, requestIp } from "../services/identity/session";
import { createCustomerPortalSession } from "../services/billing/customer-portal";

export const customerRouter = new Hono<AppContext>();
customerRouter.use("*", customerSessionAuth);

function customerId(c: any): string {
  return c.get("customerId") as string;
}

const requireRecentCustomerAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const authenticatedAt = (c as any).get("customerAuthenticatedAt") as string | undefined;
  const seconds = positiveIntegerSetting(
    (c.env as any).CUSTOMER_RECENT_AUTH_SECONDS,
    900,
    "CUSTOMER_RECENT_AUTH_SECONDS"
  );
  if (!authenticatedAt || Date.parse(authenticatedAt) < Date.now() - seconds * 1000) {
    throw new AppError(
      "CUSTOMER_RECENT_AUTH_REQUIRED",
      "A recent Magic Link authentication is required for this action",
      401
    );
  }
  await next();
};

function writeGuards() {
  return [requireExactOrigin, customerCsrf, requireRecentCustomerAuth] as const;
}

customerRouter.get("/me", async (c) => {
  const accountId = c.get("accountId")!;
  const id = customerId(c);
  const result = await c.env.DB
    .prepare(
      `SELECT id, email, name, status, created_at, updated_at
       FROM customers WHERE account_id = ?1 AND id = ?2 LIMIT 1`
    )
    .bind(accountId, id)
    .all();
  const row = result.results[0];
  if (!row) throw new NotFoundError("Customer not found");
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: row });
});

customerRouter.get("/licenses", async (c) => {
  const result = await c.env.DB
    .prepare(
      `SELECT l.id, l.product_id, p.name AS product_name, l.status,
              l.status_reason, l.license_model, l.renewal_mode, l.credential_mode,
              l.max_activations, l.features_json, l.expires_at, l.updates_until,
              l.created_at, l.updated_at
       FROM licenses AS l
       JOIN products AS p ON p.account_id = l.account_id AND p.id = l.product_id
       WHERE l.account_id = ?1 AND l.customer_id = ?2
       ORDER BY l.created_at DESC`
    )
    .bind(c.get("accountId")!, customerId(c))
    .all<any>();
  return c.json({
    success: true,
    data: {
      items: result.results.map((row) => ({ ...row, features_json: undefined, features: JSON.parse(row.features_json) })),
    },
  });
});

customerRouter.get("/licenses/:licenseId", async (c) => {
  const result = await c.env.DB
    .prepare(
      `SELECT l.id, l.product_id, p.name AS product_name, l.status,
              l.status_reason, l.license_model, l.renewal_mode, l.credential_mode,
              l.max_activations, l.features_json, l.expires_at, l.updates_until,
              l.created_at, l.updated_at
       FROM licenses AS l
       JOIN products AS p ON p.account_id = l.account_id AND p.id = l.product_id
       WHERE l.account_id = ?1 AND l.customer_id = ?2 AND l.id = ?3
       LIMIT 1`
    )
    .bind(c.get("accountId")!, customerId(c), c.req.param("licenseId"))
    .all<any>();
  const row = result.results[0];
  if (!row) throw new NotFoundError("License not found");
  const { features_json, ...license } = row;
  return c.json({ success: true, data: { ...license, features: JSON.parse(features_json) } });
});

customerRouter.get("/licenses/:licenseId/activations", async (c) => {
  const result = await c.env.DB
    .prepare(
      `SELECT a.id, a.name, a.platform, a.status, a.activated_at,
              a.last_validated_at, a.deactivated_at, a.revoked_at
       FROM activations AS a
       JOIN licenses AS l ON l.account_id = a.account_id AND l.id = a.license_id
       WHERE a.account_id = ?1 AND l.customer_id = ?2 AND l.id = ?3
       ORDER BY a.activated_at DESC`
    )
    .bind(c.get("accountId")!, customerId(c), c.req.param("licenseId"))
    .all();
  return c.json({ success: true, data: { items: result.results } });
});

customerRouter.get("/licenses/:licenseId/subscription", async (c) => {
  const result = await c.env.DB
    .prepare(
      `SELECT l.id AS license_id, l.license_model, l.renewal_mode, l.expires_at,
              s.id AS subscription_id, s.status AS subscription_status,
              s.current_period_start, s.current_period_end, s.next_billed_at,
              s.cancel_at_period_end
       FROM licenses AS l
       LEFT JOIN billing_subscriptions AS s
         ON s.account_id = l.account_id AND s.license_id = l.id
       WHERE l.account_id = ?1 AND l.customer_id = ?2 AND l.id = ?3
       LIMIT 1`
    )
    .bind(c.get("accountId")!, customerId(c), c.req.param("licenseId"))
    .all<any>();
  const row = result.results[0];
  if (!row) throw new NotFoundError("License not found");
  return c.json({
    success: true,
    data: {
      licenseId: row.license_id,
      licenseModel: row.license_model,
      renewalMode: row.renewal_mode,
      expiresAt: row.expires_at,
      billingSubscription: row.renewal_mode === "billing" && row.subscription_id
        ? {
            id: row.subscription_id,
            status: row.subscription_status,
            currentPeriodStart: row.current_period_start,
            currentPeriodEnd: row.current_period_end,
            nextBilledAt: row.next_billed_at,
            cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
          }
        : null,
    },
  });
});

customerRouter.post(
  "/licenses/:licenseId/activations/:activationId/deactivate",
  ...writeGuards(),
  async (c) => {
    const accountId = c.get("accountId")!;
    const ownerCustomerId = customerId(c);
    const licenseId = c.req.param("licenseId");
    const activationId = c.req.param("activationId");
    const exists = await c.env.DB
      .prepare(
        `SELECT a.id FROM activations AS a
         JOIN licenses AS l ON l.account_id = a.account_id AND l.id = a.license_id
         WHERE a.account_id = ?1 AND l.customer_id = ?2 AND l.id = ?3
           AND a.id = ?4 AND a.status = 'active'
         LIMIT 1`
      )
      .bind(accountId, ownerCustomerId, licenseId, activationId)
      .all<{ id: string }>();
    if (!exists.results[0]) throw new NotFoundError("Activation not found");
    const now = new Date().toISOString();
    const results = await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE activations
           SET status = 'deactivated', deactivated_at = ?1, updated_at = ?1
           WHERE account_id = ?2 AND license_id = ?3 AND id = ?4 AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM licenses
               WHERE account_id = ?2 AND id = ?3 AND customer_id = ?5
             )`
        )
        .bind(now, accountId, licenseId, activationId, ownerCustomerId),
      prepareAuditInsert({
        db: c.env.DB,
        accountId,
        actor: { type: "customer", id: ownerCustomerId },
        action: "customer.activation.deactivated",
        resourceType: "activation",
        resourceId: activationId,
        details: { licenseId },
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    const resolved = await Promise.all(results as any[]);
    if (Number(resolved[0]?.meta?.changes ?? 0) !== 1) throw new NotFoundError("Activation not found");
    return c.json({ success: true, data: { id: activationId, status: "deactivated" } });
  }
);

async function rotateFromCustomer(c: any, reason: "recovery" | "security_reset") {
  const accountId = c.get("accountId") as string;
  const ownerCustomerId = customerId(c);
  const result = await rotateLicenseKey({
    db: c.env.DB,
    env: c.env,
    accountId,
    licenseId: c.req.param("licenseId"),
    actor: { type: "customer", id: ownerCustomerId },
    reason,
    requestId: c.req.header("x-request-id"),
    ip: requestIp(c) ?? undefined,
    userAgent: c.req.header("user-agent"),
  });
  let notification: { id: string; status: string } = result.delivery;
  if (result.delivery.status === "pending") {
    const dispatched = await dispatchDelivery({
      db: c.env.DB,
      env: c.env,
      accountId,
      deliveryId: result.delivery.id,
    });
    notification = {
      id: result.delivery.id,
      status: dispatched.status ?? result.delivery.status,
    };
  }
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: { license: result.license, licenseKey: result.licenseKey, delivery: notification },
  });
}

customerRouter.post("/licenses/:licenseId/recover-key", ...writeGuards(), (c) =>
  rotateFromCustomer(c, "recovery")
);

customerRouter.post("/licenses/:licenseId/security-reset", ...writeGuards(), (c) =>
  rotateFromCustomer(c, "security_reset")
);

customerRouter.post(
  "/licenses/:licenseId/subscription/portal-session",
  ...writeGuards(),
  async (c) => {
    const accountId = c.get("accountId")!;
    const ownerCustomerId = customerId(c);
    const licenseId = c.req.param("licenseId");
    const licenseResult = await c.env.DB
      .prepare(
        `SELECT license_model, renewal_mode FROM licenses
         WHERE account_id = ?1 AND customer_id = ?2 AND id = ?3 LIMIT 1`
      )
      .bind(accountId, ownerCustomerId, licenseId)
      .all<{ license_model: string; renewal_mode: string }>();
    const license = licenseResult.results[0];
    if (!license) throw new NotFoundError("License not found");
    if (license.license_model === "subscription" && license.renewal_mode === "manual") {
      throw new AppError(
        "BILLING_SUBSCRIPTION_NOT_MANAGED",
        "This subscription is managed by the issuer and has no payment portal",
        409
      );
    }
    if (license.renewal_mode !== "billing") {
      throw new AppError(
        "BILLING_SUBSCRIPTION_NOT_SUPPORTED",
        "This License does not have a billing-managed subscription",
        409
      );
    }
    const result = await createCustomerPortalSession({
      db: c.env.DB,
      env: c.env,
      accountId,
      customerId: ownerCustomerId,
      licenseId,
    });
    await c.env.DB.batch([
      prepareAuditInsert({
        db: c.env.DB,
        accountId,
        actor: { type: "customer", id: ownerCustomerId },
        action: "customer.subscription.portal_session_created",
        resourceType: "license",
        resourceId: licenseId,
        details: { providerRequestId: result.providerRequestId, expiresAt: result.expiresAt },
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
      }),
    ]);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: { url: result.url, expiresAt: result.expiresAt } });
  }
);
