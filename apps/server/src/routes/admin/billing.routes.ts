import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext } from "../../types";
import { requireRole } from "../../middleware/auth";
import { AppError, NotFoundError } from "../../middleware/error";
import { assertPaddleClientToken, probePaddleCustomerRead } from "../../infra/billing/paddle";
import type { BillingProviderRecord } from "../../infra/billing/types";
import {
  decryptBillingProviderWebhookSecret,
  encryptBillingProviderSecret,
} from "../../infra/billing/storage";
import { serializeBillingDiagnostic } from "../../infra/billing/redaction";
import { evaluateBillingOfferReadiness, getBillingOfferReadinessRow } from "../../services/billing/readiness";
import { reconcileBillingCustomer } from "../../services/billing/customer-sync";
import { prepareLicenseKeyRotation } from "../../services/license/key-rotation";
import { BillingProcessingError, PaddleHttpError } from "../../infra/billing/errors";
import { dispatchDelivery } from "../../infra/delivery/dispatcher";
import { toSnakeCaseJson } from "./snake-case-json";
import { getPaddleWebhookRequirements } from "../../services/billing/webhook-requirements";

export const adminBillingRouter = new Hono<AppContext>();

type BillingProviderWithVerification = BillingProviderRecord & {
  webhook_verified_at: string | null;
};

const ProviderCreateSchema = z.object({
  provider: z.literal("paddle"),
  environment: z.enum(["sandbox", "live"]),
  client_side_token: z.string().min(6).max(512),
  webhook_secret: z.string().min(16).max(2048),
  api_key: z.string().min(16).max(4096).optional(),
}).strict().transform((input) => ({
  provider: input.provider,
  environment: input.environment,
  clientSideToken: input.client_side_token,
  webhookSecret: input.webhook_secret,
  apiKey: input.api_key,
}));

const ProviderPatchSchema = z.object({
  provider: z.literal("paddle").optional(),
  environment: z.enum(["sandbox", "live"]).optional(),
  client_side_token: z.string().min(6).max(512).optional(),
  webhook_secret: z.string().min(16).max(2048).optional(),
  api_key: z.string().min(16).max(4096).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().transform((input) => ({
  provider: input.provider,
  environment: input.environment,
  clientSideToken: input.client_side_token,
  webhookSecret: input.webhook_secret,
  apiKey: input.api_key,
  status: input.status,
}));

const ProviderConfigurationCheckSchema = z.object({}).strict();

const OfferCreateSchema = z.object({
  billing_provider_id: z.string().min(1).max(128),
  external_price_id: z.string().regex(/^pri_[A-Za-z0-9]+$/),
  product_id: z.string().min(1).max(128),
  license_plan_id: z.string().min(1).max(128),
  purchase_type: z.enum(["one_time", "subscription"]),
}).strict().transform((input) => ({
  billingProviderId: input.billing_provider_id,
  externalPriceId: input.external_price_id,
  productId: input.product_id,
  licensePlanId: input.license_plan_id,
  purchaseType: input.purchase_type,
}));

const OfferPatchSchema = z.object({
  billing_provider_id: z.string().min(1).max(128).optional(),
  external_price_id: z.string().regex(/^pri_[A-Za-z0-9]+$/).optional(),
  product_id: z.string().min(1).max(128).optional(),
  license_plan_id: z.string().min(1).max(128).optional(),
  purchase_type: z.enum(["one_time", "subscription"]).optional(),
}).strict().transform((input) => ({
  billingProviderId: input.billing_provider_id,
  externalPriceId: input.external_price_id,
  productId: input.product_id,
  licensePlanId: input.license_plan_id,
  purchaseType: input.purchase_type,
}));

function instanceId(c: any): string {
  const value = c.get("instanceId");
  if (!value) throw new AppError("ADMIN_INSTANCE_CONTEXT_MISSING", "Authenticated instance context is required.", 500);
  return value;
}

function requireAdminContext(c: any): void {
  instanceId(c);
  if (!c.get("userId")) throw new AppError("ADMIN_USER_CONTEXT_MISSING", "Authenticated user context is required.", 500);
}

function prepareAudit(
  c: any,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details: Record<string, unknown>,
): D1PreparedStatement {
  requireAdminContext(c);
  const id = `aud_${ulid().toLowerCase()}`;
  return c.env.DB.prepare(
    `INSERT INTO audit_logs (
       id, scope_type, instance_id, actor_type, actor_user_id, actor_customer_id,
       action, resource_type, resource_id, request_id,
       details_redacted_json, ip, user_agent, created_at
     ) VALUES (?1, 'instance', ?2, 'user', ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    id,
    instanceId(c),
    c.get("userId"),
    action,
    resourceType,
    resourceId,
    c.get("requestId") ?? null,
    serializeBillingDiagnostic(details),
    c.req.header("cf-connecting-ip") ?? null,
    c.req.header("user-agent")?.slice(0, 512) ?? null,
    new Date().toISOString(),
  );
}

function maskToken(token: string): string {
  return token.length <= 12 ? `${token.slice(0, 5)}***` : `${token.slice(0, 8)}***${token.slice(-4)}`;
}

function asBillingRouteError(error: unknown): never {
  if (error instanceof BillingProcessingError) {
    throw new AppError(
      error.code,
      error.message,
      error.disposition === "failed" ? 400 : error.disposition === "retry" ? 502 : 409,
      toSnakeCaseJson({ ...error.details, disposition: error.disposition }) as Record<string, unknown>,
    );
  }
  throw error;
}

function assertPaddleClientTokenForRoute(environment: "sandbox" | "live", token: string): void {
  try {
    assertPaddleClientToken(environment, token);
  } catch (error) {
    asBillingRouteError(error);
  }
}

adminBillingRouter.get("/providers", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, instance_id, provider, environment, client_side_token,
            webhook_secret_ciphertext, simulator_webhook_secret_version,
            api_secret_ciphertext,
            status, created_at, updated_at,
            (SELECT event.received_at
             FROM inbound_events AS event
             WHERE event.instance_id = billing_providers.instance_id
               AND event.billing_provider_id = billing_providers.id
               AND event.webhook_secret_version = billing_providers.webhook_secret_version
               AND substr(event.external_event_id, 1, 4) = 'evt_'
             ORDER BY event.received_at DESC
             LIMIT 1) AS webhook_verified_at
     FROM billing_providers
     WHERE instance_id = ?1
     ORDER BY created_at DESC
     LIMIT 100`,
  ).bind(instanceId(c)).all<{
    id: string; instance_id: string; provider: string; environment: string; client_side_token: string;
    webhook_secret_ciphertext: string; simulator_webhook_secret_version: number;
    api_secret_ciphertext: string | null; status: string; created_at: string; updated_at: string;
    webhook_verified_at: string | null;
  }>();
  return c.json({
    success: true,
    data: {
      items: await Promise.all(result.results.map(async (row) => {
        const requirements = await getPaddleWebhookRequirements(c.env.DB, row);
        return {
          id: row.id,
          provider: row.provider,
          environment: row.environment,
          client_side_token: row.client_side_token,
          webhook_secret_configured: requirements.webhookSecretConfigured,
          webhook_verified_at: row.webhook_verified_at,
          simulator_test_completed_at: requirements.completedAt,
          required_event_types: requirements.requiredEventTypes,
          verified_event_types: requirements.verifiedEventTypes,
          missing_event_types: requirements.missingEventTypes,
          api_key_configured: requirements.apiKeyConfigured,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
      })),
    },
  });
});

adminBillingRouter.post("/providers", requireRole(["owner", "admin"]), async (c) => {
  const input = ProviderCreateSchema.parse(await c.req.json());
  assertPaddleClientTokenForRoute(input.environment, input.clientSideToken);
  const id = `bpr_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();
  const webhookCiphertext = await encryptBillingProviderSecret(
    input.webhookSecret,
    c.env,
    instanceId(c),
    id,
    "webhook_secret_ciphertext",
  );
  const apiCiphertext = input.apiKey
    ? await encryptBillingProviderSecret(input.apiKey, c.env, instanceId(c), id, "api_secret_ciphertext")
    : null;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO billing_providers (
           id, instance_id, provider, environment, client_side_token,
           webhook_secret_ciphertext, api_secret_ciphertext, status, created_at, updated_at
         ) VALUES (?1, ?2, 'paddle', ?3, ?4, ?5, ?6, 'active', ?7, ?7)`,
      ).bind(
        id,
        instanceId(c),
        input.environment,
        input.clientSideToken,
        webhookCiphertext,
        apiCiphertext,
        now,
      ),
      prepareAudit(c, "billing.provider.create", "billing_provider", id, {
        provider: "paddle",
        environment: input.environment,
        clientSideToken: maskToken(input.clientSideToken),
        apiKeyConfigured: Boolean(input.apiKey),
      }),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new AppError("BILLING_PROVIDER_ALREADY_EXISTS", "A Paddle connection already exists for this environment.", 409, {
        provider: "paddle", environment: input.environment,
      });
    }
    throw error;
  }
  return c.json({
    success: true,
    data: {
      id,
      provider: "paddle",
      environment: input.environment,
      client_side_token: input.clientSideToken,
      webhook_secret_configured: true,
      webhook_verified_at: null,
      simulator_test_completed_at: null,
      api_key_configured: Boolean(input.apiKey),
      status: "active",
    },
  }, 201);
});

adminBillingRouter.patch("/providers/:providerId", requireRole(["owner", "admin"]), async (c) => {
  const input = ProviderPatchSchema.parse(await c.req.json());
  const provider = await getProvider(c.env.DB, instanceId(c), c.req.param("providerId"));
  if (!provider) throw new NotFoundError("Billing Provider not found.");
  if ((input.provider && input.provider !== provider.provider) ||
      (input.environment && input.environment !== provider.environment)) {
    throw new AppError(
      "BILLING_PROVIDER_IDENTITY_IMMUTABLE",
      "Provider and environment cannot be changed; create another connection.",
      409,
      { provider_id: provider.id, provider: provider.provider, environment: provider.environment },
    );
  }
  const clientToken = input.clientSideToken ?? provider.client_side_token;
  assertPaddleClientTokenForRoute(provider.environment, clientToken);
  const webhookCiphertext = input.webhookSecret
    ? await encryptBillingProviderSecret(input.webhookSecret, c.env, provider.instance_id, provider.id, "webhook_secret_ciphertext")
    : provider.webhook_secret_ciphertext;
  const apiCiphertext = input.apiKey === undefined
    ? provider.api_secret_ciphertext
    : input.apiKey === null
      ? null
      : await encryptBillingProviderSecret(input.apiKey, c.env, provider.instance_id, provider.id, "api_secret_ciphertext");
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE billing_providers
       SET client_side_token = ?1, webhook_secret_ciphertext = ?2,
           webhook_secret_version = CASE WHEN ?3 = 1 THEN webhook_secret_version + 1 ELSE webhook_secret_version END,
           simulator_webhook_secret_version = CASE WHEN ?3 = 1 THEN simulator_webhook_secret_version + 1 ELSE simulator_webhook_secret_version END,
           api_secret_ciphertext = ?4, status = ?5, updated_at = ?6
       WHERE instance_id = ?7 AND id = ?8`,
    ).bind(
      clientToken,
      webhookCiphertext,
      input.webhookSecret !== undefined ? 1 : 0,
      apiCiphertext,
      input.status ?? provider.status,
      now,
      provider.instance_id,
      provider.id,
    ),
    prepareAudit(c, "billing.provider.update", "billing_provider", provider.id, {
      clientSideTokenRotated: input.clientSideToken !== undefined,
      webhookSecretRotated: input.webhookSecret !== undefined,
      apiKeyChanged: input.apiKey !== undefined,
      status: input.status ?? provider.status,
    }),
  ]);
  return c.json({ success: true, data: { id: provider.id, updated_at: now } });
});

adminBillingRouter.post("/providers/:providerId/test", requireRole(["owner", "admin"]), async (c) => {
  ProviderConfigurationCheckSchema.parse(await c.req.json().catch(() => ({})));
  const provider = await getProvider(c.env.DB, instanceId(c), c.req.param("providerId"));
  if (!provider) throw new NotFoundError("Billing Provider not found.");
  assertPaddleClientTokenForRoute(provider.environment, provider.client_side_token);
  const secret = await decryptBillingProviderWebhookSecret(provider, c.env);
  const requirements = await getPaddleWebhookRequirements(c.env.DB, provider);
  let apiKeyCustomerRead: {
    status: "ok" | "error" | "not_configured";
    operation: "customers.list";
    errorCode: string | null;
    providerCode: string | null;
    httpStatus: number | null;
    requestId: string | null;
    retryAfter: string | null;
    message: string | null;
  } = {
    status: "not_configured", operation: "customers.list", errorCode: null,
    providerCode: null, httpStatus: null, requestId: null, retryAfter: null, message: null,
  };
  if (provider.api_secret_ciphertext) {
    try {
      const result = await probePaddleCustomerRead(provider, c.env);
      apiKeyCustomerRead = { ...apiKeyCustomerRead, status: "ok", httpStatus: 200, requestId: result.requestId };
    } catch (error) {
      if (!(error instanceof BillingProcessingError)) throw error;
      apiKeyCustomerRead = {
        ...apiKeyCustomerRead,
        status: "error",
        errorCode: error.code,
        providerCode: error instanceof PaddleHttpError ? error.providerDetails.providerCode : null,
        httpStatus: error instanceof PaddleHttpError ? error.providerDetails.httpStatus : null,
        requestId: error instanceof PaddleHttpError ? error.providerDetails.requestId : null,
        retryAfter: error instanceof PaddleHttpError ? error.providerDetails.retryAfter : null,
        message: error.message,
      };
    }
  }
  return c.json({
    success: true,
    data: {
      provider_id: provider.id,
      provider: "paddle",
      environment: provider.environment,
      client_side_token_valid: true,
      webhook_secret_decryptable: secret.length > 0,
      webhook_verified_at: provider.webhook_verified_at,
      simulator_test_completed_at: requirements.completedAt,
      required_event_types: requirements.requiredEventTypes,
      verified_event_types: requirements.verifiedEventTypes,
      missing_event_types: requirements.missingEventTypes,
      api_key_configured: requirements.apiKeyConfigured,
      api_key_customer_read: toSnakeCaseJson(apiKeyCustomerRead),
    },
  });
});

adminBillingRouter.get("/offers", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT offer.id, offer.billing_provider_id, offer.external_price_id,
            offer.product_id, offer.license_plan_id, offer.purchase_type,
            offer.status, offer.created_at, offer.updated_at,
            plan.name AS name, provider.environment
     FROM billing_offers AS offer
     JOIN license_plans AS plan
       ON plan.instance_id = offer.instance_id AND plan.id = offer.license_plan_id
     JOIN billing_providers AS provider
       ON provider.instance_id = offer.instance_id AND provider.id = offer.billing_provider_id
     WHERE offer.instance_id = ?1
     ORDER BY offer.created_at DESC
     LIMIT 100`,
  ).bind(instanceId(c)).all<Record<string, unknown>>();
  return c.json({ success: true, data: { items: result.results } });
});

adminBillingRouter.post("/offers", requireRole(["owner", "admin"]), async (c) => {
  const input = OfferCreateSchema.parse(await c.req.json());
  const instance = instanceId(c);
  await assertOfferMapping(c.env.DB, instance, input);
  const id = `off_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO billing_offers (
           id, instance_id, billing_provider_id, external_price_id,
           product_id, license_plan_id, purchase_type, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?8)`,
      ).bind(id, instance, input.billingProviderId, input.externalPriceId, input.productId, input.licensePlanId, input.purchaseType, now),
      prepareAudit(c, "billing.offer.create", "billing_offer", id, input),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new AppError("BILLING_OFFER_PRICE_ALREADY_MAPPED", "This Paddle Price is already mapped.", 409, {
        billing_provider_id: input.billingProviderId, external_price_id: input.externalPriceId,
      });
    }
    throw error;
  }
  return c.json({ success: true, data: { id, status: "draft" } }, 201);
});

adminBillingRouter.patch("/offers/:offerId", requireRole(["owner", "admin"]), async (c) => {
  const input = OfferPatchSchema.parse(await c.req.json());
  const instance = instanceId(c);
  const current = await c.env.DB.prepare(
    `SELECT billing_provider_id, external_price_id, product_id, license_plan_id, purchase_type, status
     FROM billing_offers WHERE instance_id = ?1 AND id = ?2 LIMIT 1`,
  ).bind(instance, c.req.param("offerId")).first<any>();
  if (!current) throw new NotFoundError("Billing Offer not found.");
  if (current.status !== "draft") {
    throw new AppError("BILLING_OFFER_NOT_EDITABLE", "Only draft Offers can be edited.", 409);
  }
  const verification = await c.env.DB.prepare(
    `SELECT id FROM billing_checkout_verifications
     WHERE instance_id = ?1 AND billing_offer_id = ?2 LIMIT 1`,
  ).bind(instance, c.req.param("offerId")).first<{ id: string }>();
  if (verification) {
    throw new AppError("BILLING_OFFER_VERIFICATION_EXISTS", "Archive this Offer and create another mapping.", 409, {
      offer_id: c.req.param("offerId"), verification_id: verification.id,
    });
  }
  const merged = {
    billingProviderId: input.billingProviderId ?? current.billing_provider_id,
    externalPriceId: input.externalPriceId ?? current.external_price_id,
    productId: input.productId ?? current.product_id,
    licensePlanId: input.licensePlanId ?? current.license_plan_id,
    purchaseType: input.purchaseType ?? current.purchase_type,
  };
  await assertOfferMapping(c.env.DB, instance, merged);
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE billing_offers
       SET billing_provider_id = ?1, external_price_id = ?2, product_id = ?3,
           license_plan_id = ?4, purchase_type = ?5, updated_at = ?6
       WHERE instance_id = ?7 AND id = ?8 AND status = 'draft'`,
    ).bind(merged.billingProviderId, merged.externalPriceId, merged.productId, merged.licensePlanId,
      merged.purchaseType, now, instance, c.req.param("offerId")),
    prepareAudit(c, "billing.offer.update", "billing_offer", c.req.param("offerId"), merged),
  ]);
  return c.json({ success: true, data: { id: c.req.param("offerId"), status: "draft", updated_at: now } });
});

adminBillingRouter.get("/offers/:offerId/test-checkout-config", requireRole(["owner", "admin"]), async (c) => {
  const instance = instanceId(c);
  const row = await c.env.DB.prepare(
    `SELECT offer.id, offer.external_price_id,
            provider.environment, provider.client_side_token
     FROM billing_offers AS offer
     JOIN billing_providers AS provider
       ON provider.instance_id = offer.instance_id AND provider.id = offer.billing_provider_id
     WHERE offer.instance_id = ?1 AND offer.id = ?2
       AND offer.status = 'active' AND provider.status = 'active'
       AND provider.environment = 'sandbox'
     LIMIT 1`,
  ).bind(instance, c.req.param("offerId")).first<any>();
  if (!row) {
    throw new AppError(
      "BILLING_TEST_CHECKOUT_UNAVAILABLE",
      "Test checkout requires an active Paddle Sandbox Provider and an active Offer.",
      409,
      { offer_id: c.req.param("offerId") },
    );
  }
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: {
      checkout: {
        provider: "paddle",
        environment: "sandbox",
        client_side_token: row.client_side_token,
        price_id: row.external_price_id,
        quantity: 1,
      },
    },
  });
});

adminBillingRouter.post("/offers/:offerId/activate", requireRole(["owner", "admin"]), async (c) => {
  const instance = instanceId(c);
  const row = await getBillingOfferReadinessRow(c.env.DB, instance, c.req.param("offerId"));
  if (!row) throw new NotFoundError("Billing Offer not found.");
  if (row.offer_status !== "draft") {
    throw new AppError("BILLING_OFFER_NOT_DRAFT", "Only a draft Offer can be activated.", 409);
  }
  const readiness = await evaluateBillingOfferReadiness(c.env.DB, row, {
    env: c.env,
    activation: true,
  });
  if (!readiness.ready) {
    throw new AppError(
      "BILLING_CHECKOUT_NOT_READY",
      "Checkout dependencies are not ready.",
      409,
      { offer_id: row.id, checks: toSnakeCaseJson(readiness.checks) },
    );
  }
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE billing_offers SET status = 'active', updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3 AND status = 'draft'`,
    ).bind(now, instance, row.id),
    prepareAudit(c, "billing.offer.activate", "billing_offer", row.id, { checks: readiness.checks }),
  ]);
  return c.json({ success: true, data: { id: row.id, status: "active", readiness: toSnakeCaseJson(readiness) } });
});

adminBillingRouter.post("/offers/:offerId/archive", requireRole(["owner", "admin"]), async (c) => {
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE billing_offers SET status = 'archived', updated_at = ?1
     WHERE instance_id = ?2 AND id = ?3 AND status <> 'archived'`,
  ).bind(now, instanceId(c), c.req.param("offerId")).run();
  if (!result.meta.changes) throw new NotFoundError("Billing Offer not found or already archived.");
  await c.env.DB.batch([prepareAudit(c, "billing.offer.archive", "billing_offer", c.req.param("offerId"), {})]);
  return c.json({ success: true, data: { id: c.req.param("offerId"), status: "archived" } });
});

adminBillingRouter.get("/customers", requireRole(["owner", "admin", "member", "viewer"]), async (c) => listBillingRows(c, "billing_customers", "updated_at"));
adminBillingRouter.get("/subscriptions", requireRole(["owner", "admin", "member", "viewer"]), async (c) => listBillingRows(c, "billing_subscriptions", "updated_at"));
adminBillingRouter.get("/events", requireRole(["owner", "admin", "member", "viewer"]), async (c) => listBillingRows(c, "inbound_events", "received_at"));
adminBillingRouter.get("/events/rejections", requireRole(["owner", "admin", "member", "viewer"]), async (c) => {
  const requestedLimit = Number(c.req.query("limit") ?? 50);
  const requestedOffset = Number(c.req.query("offset") ?? 0);
  const requestId = c.req.query("request_id")?.trim();
  if (!Number.isInteger(requestedLimit) || !Number.isInteger(requestedOffset)
    || requestedLimit < 1 || requestedOffset < 0 || (requestId !== undefined && requestId.length > 128)) {
    throw new AppError("VALIDATION_ERROR", "Invalid rejection list query.", 400);
  }
  const limit = Math.min(100, requestedLimit);
  const query = `SELECT rejection.id, rejection.billing_provider_id, rejection.request_id,
                        rejection.error_code, rejection.http_status,
                        rejection.webhook_secret_version, rejection.payload_hash,
                        rejection.received_at, provider.provider, provider.environment
                 FROM webhook_rejections AS rejection
                 JOIN billing_providers AS provider
                   ON provider.instance_id = rejection.instance_id
                  AND provider.id = rejection.billing_provider_id
                 WHERE rejection.instance_id = ?1${requestId ? " AND rejection.request_id = ?2" : ""}
                 ORDER BY rejection.received_at DESC, rejection.id DESC
                 LIMIT ?${requestId ? 3 : 2} OFFSET ?${requestId ? 4 : 3}`;
  const result = await c.env.DB.prepare(query)
    .bind(instanceId(c), ...(requestId ? [requestId] : []), limit, requestedOffset)
    .all<Record<string, unknown>>();
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: {
    items: result.results.map((row) => ({ ...row, status: "rejected" })),
    pagination: { limit, offset: requestedOffset },
  } });
});
adminBillingRouter.get("/adjustments", requireRole(["owner", "admin", "member", "viewer"]), async (c) => listBillingRows(c, "billing_adjustments", "updated_at"));

adminBillingRouter.get("/customers/:billingCustomerId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => detailBillingRow(c, "billing_customers", c.req.param("billingCustomerId")));
adminBillingRouter.get("/subscriptions/:subscriptionId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => detailBillingRow(c, "billing_subscriptions", c.req.param("subscriptionId")));
adminBillingRouter.get("/events/:eventId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => detailBillingRow(c, "inbound_events", c.req.param("eventId"), ["payload_ciphertext"]));
adminBillingRouter.get("/adjustments/:adjustmentId", requireRole(["owner", "admin", "member", "viewer"]), async (c) => detailBillingRow(c, "billing_adjustments", c.req.param("adjustmentId")));

adminBillingRouter.post("/customers/:billingCustomerId/reconcile", requireRole(["owner", "admin"]), async (c) => {
  let result: Record<string, unknown>;
  try {
    result = await reconcileBillingCustomer({
      db: c.env.DB,
      env: c.env,
      instanceId: instanceId(c),
      billingCustomerId: c.req.param("billingCustomerId"),
    });
  } catch (error) {
    asBillingRouteError(error);
  }
  return c.json({ success: true, data: toSnakeCaseJson(result) });
});

adminBillingRouter.post("/events/:eventId/replay", requireRole(["owner", "admin"]), async (c) => {
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE inbound_events
     SET status = 'pending', next_attempt_at = ?1, locked_by = NULL, locked_until = NULL,
         updated_at = ?1
     WHERE instance_id = ?2 AND id = ?3
       AND status IN ('failed', 'needs_attention')
       AND substr(external_event_id, 1, 4) = 'evt_'
       AND payload_ciphertext IS NOT NULL
       AND payload_expires_at > ?1`,
  ).bind(now, instanceId(c), c.req.param("eventId")).run();
  if (!result.meta.changes) {
    throw new AppError(
      "BILLING_EVENT_NOT_REPLAYABLE",
      "Only a failed platform event with an unexpired encrypted payload can be replayed.",
      409,
      { event_id: c.req.param("eventId") },
    );
  }
  await c.env.DB.batch([prepareAudit(c, "billing.event.replay", "inbound_event", c.req.param("eventId"), {})]);
  return c.json({ success: true, data: { id: c.req.param("eventId"), status: "pending" } });
});

const ResolveAdjustmentSchema = z.object({
  action: z.enum(["no_action", "keep_suspended", "reinstate", "revoke", "security_reset"]),
  reason: z.string().trim().min(1).max(2000),
}).strict();

adminBillingRouter.post("/adjustments/:adjustmentId/resolve", requireRole(["owner", "admin"]), async (c) => {
  const input = ResolveAdjustmentSchema.parse(await c.req.json());
  const instance = instanceId(c);
  const adjustment = await c.env.DB.prepare(
    `SELECT id, license_id, review_status
     FROM billing_adjustments
     WHERE instance_id = ?1 AND id = ?2
     LIMIT 1`,
  ).bind(instance, c.req.param("adjustmentId")).first<{
    id: string; license_id: string | null; review_status: string;
  }>();
  if (!adjustment) throw new NotFoundError("Billing Adjustment not found.");
  if (adjustment.review_status !== "open") {
    throw new AppError("BILLING_ADJUSTMENT_NOT_OPEN", "Only an open Adjustment can be resolved.", 409);
  }
  if (!adjustment.license_id && input.action !== "no_action") {
    throw new AppError("BILLING_ADJUSTMENT_LICENSE_UNRESOLVED", "Resolve the target License before applying this action.", 409);
  }
  const now = new Date();
  const statements: D1PreparedStatement[] = [];
  let rotationDelivery: { id: string; status: string } | null = null;
  if (adjustment.license_id && input.action === "reinstate") {
    statements.push(c.env.DB.prepare(
      `UPDATE licenses SET status = 'active', status_reason = NULL, suspended_at = NULL, updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3 AND is_checkout_verification = 0`,
    ).bind(now.toISOString(), instance, adjustment.license_id));
  } else if (adjustment.license_id && input.action === "revoke") {
    statements.push(c.env.DB.prepare(
      `UPDATE licenses SET status = 'revoked', status_reason = 'billing_adjustment', revoked_at = ?1, updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3 AND is_checkout_verification = 0`,
    ).bind(now.toISOString(), instance, adjustment.license_id));
  } else if (adjustment.license_id && input.action === "security_reset") {
    const userId = c.get("userId");
    if (!userId) throw new AppError("ADMIN_USER_CONTEXT_MISSING", "Authenticated user context is required.", 500);
    const rotation = await prepareLicenseKeyRotation({
      db: c.env.DB,
      env: c.env,
      instanceId: instance,
      licenseId: adjustment.license_id,
      actor: { type: "user", id: userId },
      reason: "security_reset",
      requestId: c.get("requestId"),
      ip: c.req.header("cf-connecting-ip"),
      userAgent: c.req.header("user-agent"),
      now,
    });
    statements.push(...rotation.statements);
    rotationDelivery = rotation.delivery;
  }
  statements.push(c.env.DB.prepare(
    `UPDATE billing_adjustments
     SET review_status = 'resolved', resolution_action = ?1, resolution_reason = ?2,
         resolved_by_user_id = ?3, resolved_at = ?4, updated_at = ?4
     WHERE instance_id = ?5 AND id = ?6 AND review_status = 'open'`,
  ).bind(input.action, input.reason, c.get("userId"), now.toISOString(), instance, adjustment.id));
  statements.push(prepareAudit(c, "billing.adjustment.resolve", "billing_adjustment", adjustment.id, {
    action: input.action, reason: input.reason, licenseId: adjustment.license_id,
  }));
  await c.env.DB.batch(statements);
  if (rotationDelivery?.status === "pending") {
    try {
      await dispatchDelivery({
        db: c.env.DB,
        env: c.env,
        instanceId: instance,
        deliveryId: rotationDelivery.id,
      });
    } catch (error) {
      // The Adjustment, key rotation, and pending Delivery are already durable.
      // The shared Scheduler owns recovery; never turn a Provider-side failure
      // into an apparent rollback of those committed facts.
      console.error("Billing adjustment email Delivery immediate trigger failed", {
        code: "EMAIL_DELIVERY_IMMEDIATE_TRIGGER_FAILED",
        instanceId: instance,
        deliveryId: rotationDelivery.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return c.json({ success: true, data: { id: adjustment.id, review_status: "resolved", resolution_action: input.action } });
});

async function getProvider(
  db: D1Database,
  instance: string,
  providerId: string,
): Promise<BillingProviderWithVerification | null> {
  const row = await db.prepare(
    `SELECT id, instance_id, provider, environment, client_side_token,
            webhook_secret_ciphertext, webhook_secret_version,
            simulator_webhook_secret_ciphertext, simulator_webhook_secret_version,
            api_secret_ciphertext,
            status, created_at, updated_at,
            (SELECT event.received_at
             FROM inbound_events AS event
             WHERE event.instance_id = billing_providers.instance_id
               AND event.billing_provider_id = billing_providers.id
               AND event.webhook_secret_version = billing_providers.webhook_secret_version
               AND substr(event.external_event_id, 1, 4) = 'evt_'
             ORDER BY event.received_at DESC
             LIMIT 1) AS webhook_verified_at
     FROM billing_providers WHERE instance_id = ?1 AND id = ?2 LIMIT 1`,
  ).bind(instance, providerId).first<BillingProviderWithVerification>();
  return row ?? null;
}

async function assertOfferMapping(
  db: D1Database,
  instance: string,
  input: z.infer<typeof OfferCreateSchema>,
): Promise<void> {
  const row = await db.prepare(
    `SELECT provider.provider, provider.environment, provider.status AS provider_status,
            product.status AS product_status, plan.status AS plan_status,
            plan.license_model
     FROM billing_providers AS provider
     JOIN products AS product ON product.instance_id = provider.instance_id AND product.id = ?3
     JOIN license_plans AS plan
       ON plan.instance_id = product.instance_id AND plan.product_id = product.id AND plan.id = ?4
     WHERE provider.instance_id = ?1 AND provider.id = ?2
     LIMIT 1`,
  ).bind(instance, input.billingProviderId, input.productId, input.licensePlanId).first<any>();
  if (!row) throw new AppError("BILLING_OFFER_RELATION_INVALID", "Provider, Product, and License Plan must belong to this Instance and Product.", 400);
  if (row.provider !== "paddle") throw new AppError("BILLING_PROVIDER_UNSUPPORTED", "Only Paddle is implemented in V1.", 400);
  const validType = input.purchaseType === "subscription"
    ? row.license_model === "subscription"
    : row.license_model === "perpetual" || row.license_model === "fixed_term";
  if (!validType) throw new AppError("BILLING_OFFER_PURCHASE_TYPE_MISMATCH", "Offer purchase type does not match the License Plan model.", 400, {
    purchase_type: input.purchaseType, license_model: row.license_model,
  });
}

async function listBillingRows(c: any, table: string, orderColumn: string): Promise<Response> {
  const requestedLimit = Number(c.req.query("limit") ?? 50);
  const requestedOffset = Number(c.req.query("offset") ?? 0);
  const status = c.req.query("status") as string | undefined;
  if (!Number.isInteger(requestedLimit) || !Number.isInteger(requestedOffset)) {
    throw new AppError("VALIDATION_ERROR", "limit and offset must be integers.", 400);
  }
  const limit = Math.min(100, Math.max(1, requestedLimit));
  const offset = Math.max(0, requestedOffset);
  const allowed = new Set(["billing_customers", "billing_subscriptions", "inbound_events", "billing_adjustments"]);
  if (!allowed.has(table)) throw new Error("Unsupported billing table");
  const isEvent = table === "inbound_events";
  const source = isEvent
    ? `inbound_events AS event JOIN billing_providers AS provider
         ON provider.instance_id = event.instance_id AND provider.id = event.billing_provider_id`
    : table;
  const columns = isEvent
    ? "event.*, event.external_event_type AS event_type, provider.provider, provider.environment"
    : "*";
  const instanceColumn = isEvent ? "event.instance_id" : "instance_id";
  const statusColumn = isEvent ? "event.status" : "status";
  const orderedColumn = isEvent ? `event.${orderColumn}` : orderColumn;
  const statuses: string[] = typeof status === "string" ? status.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
  let result;
  if (statuses.length === 1) {
    result = await (c.env.DB as D1Database).prepare(
      `SELECT ${columns} FROM ${source} WHERE ${instanceColumn} = ?1 AND ${statusColumn} = ?2 ORDER BY ${orderedColumn} DESC LIMIT ?3 OFFSET ?4`,
    ).bind(instanceId(c), statuses[0], limit, offset).all<Record<string, unknown>>();
  } else if (statuses.length > 1) {
    const placeholders = statuses.map((_: string, i: number) => `?${i + 2}`).join(", ");
    result = await (c.env.DB as D1Database).prepare(
      `SELECT ${columns} FROM ${source} WHERE ${instanceColumn} = ?1 AND ${statusColumn} IN (${placeholders}) ORDER BY ${orderedColumn} DESC LIMIT ?${statuses.length + 2} OFFSET ?${statuses.length + 3}`,
    ).bind(instanceId(c), ...statuses, limit, offset).all<Record<string, unknown>>();
  } else {
    result = await (c.env.DB as D1Database).prepare(
      `SELECT ${columns} FROM ${source} WHERE ${instanceColumn} = ?1 ORDER BY ${orderedColumn} DESC LIMIT ?2 OFFSET ?3`,
    ).bind(instanceId(c), limit, offset).all<Record<string, unknown>>();
  }
  const items = result.results.map((row: Record<string, unknown>) => {
    const copy = { ...row };
    delete copy.payload_ciphertext;
    return copy;
  });
  return c.json({ success: true, data: { items, pagination: { limit, offset } } });
}

async function detailBillingRow(c: any, table: string, id: string, hidden: string[] = []): Promise<Response> {
  const allowed = new Set(["billing_customers", "billing_subscriptions", "inbound_events", "billing_adjustments"]);
  if (!allowed.has(table)) throw new Error("Unsupported billing table");
  const isEvent = table === "inbound_events";
  const source = isEvent
    ? `inbound_events AS event JOIN billing_providers AS provider
         ON provider.instance_id = event.instance_id AND provider.id = event.billing_provider_id`
    : table;
  const columns = isEvent
    ? "event.*, event.external_event_type AS event_type, provider.provider, provider.environment"
    : "*";
  const instanceColumn = isEvent ? "event.instance_id" : "instance_id";
  const idColumn = isEvent ? "event.id" : "id";
  const row = await (c.env.DB as D1Database).prepare(`SELECT ${columns} FROM ${source} WHERE ${instanceColumn} = ?1 AND ${idColumn} = ?2 LIMIT 1`)
    .bind(instanceId(c), id).first<Record<string, unknown>>();
  if (!row) throw new NotFoundError("Billing resource not found.");
  const data = { ...row };
  hidden.forEach((field) => delete data[field]);
  return c.json({ success: true, data });
}
