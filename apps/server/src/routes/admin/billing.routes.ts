import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext } from "../../types";
import { requireRole } from "../../middleware/auth";
import { AppError, NotFoundError } from "../../middleware/error";
import {
  assertPaddleClientToken,
  verifyPaddleWebhookSignature,
} from "../../infra/billing/paddle";
import type { BillingProviderRecord } from "../../infra/billing/types";
import {
  decryptBillingProviderWebhookSecret,
  encryptBillingProviderSecret,
} from "../../infra/billing/storage";
import { serializeBillingDiagnostic } from "../../infra/billing/redaction";
import { evaluateBillingOfferReadiness, getBillingOfferReadinessRow } from "../../services/billing/readiness";
import { reconcileBillingCustomer } from "../../services/billing/customer-sync";
import { prepareLicenseKeyRotation } from "../../services/license/key-rotation";
import { sha256Hex } from "../../infra/crypto";
import { BillingProcessingError } from "../../infra/billing/errors";

export const adminBillingRouter = new Hono<AppContext>();

const ProviderCreateSchema = z.object({
  provider: z.literal("paddle"),
  environment: z.enum(["sandbox", "live"]),
  clientSideToken: z.string().min(6).max(512),
  webhookSecret: z.string().min(16).max(2048),
  apiKey: z.string().min(16).max(4096).optional(),
});

const ProviderPatchSchema = z.object({
  provider: z.literal("paddle").optional(),
  environment: z.enum(["sandbox", "live"]).optional(),
  clientSideToken: z.string().min(6).max(512).optional(),
  webhookSecret: z.string().min(16).max(2048).optional(),
  apiKey: z.string().min(16).max(4096).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict();

const ProviderTestSchema = z.object({
  rawBody: z.string().max(1_000_000).optional(),
  paddleSignature: z.string().max(4096).optional(),
}).refine((value) => Boolean(value.rawBody) === Boolean(value.paddleSignature), {
  message: "rawBody and paddleSignature must be provided together",
});

const OfferCreateSchema = z.object({
  billingProviderId: z.string().min(1).max(128),
  externalPriceId: z.string().regex(/^pri_[A-Za-z0-9]+$/),
  productId: z.string().min(1).max(128),
  licensePlanId: z.string().min(1).max(128),
  purchaseType: z.enum(["one_time", "subscription"]),
}).strict();

const OfferPatchSchema = OfferCreateSchema.partial().strict();

function accountId(c: any): string {
  const value = c.get("accountId");
  if (!value) throw new AppError("ADMIN_ACCOUNT_CONTEXT_MISSING", "Authenticated account context is required.", 500);
  return value;
}

function requireAdminContext(c: any): void {
  accountId(c);
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
       id, account_id, actor_type, actor_user_id, actor_customer_id,
       action, resource_type, resource_id, request_id,
       details_redacted_json, ip, user_agent, created_at
     ) VALUES (?1, ?2, 'user', ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    id,
    accountId(c),
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
      { ...error.details, disposition: error.disposition },
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
    `SELECT id, provider, environment, client_side_token, api_secret_ciphertext,
            status, created_at, updated_at
     FROM billing_providers
     WHERE account_id = ?1
     ORDER BY created_at DESC
     LIMIT 100`,
  ).bind(accountId(c)).all<{
    id: string; provider: string; environment: string; client_side_token: string;
    api_secret_ciphertext: string | null; status: string; created_at: string; updated_at: string;
  }>();
  return c.json({
    success: true,
    data: {
      items: result.results.map((row) => ({
        id: row.id,
        provider: row.provider,
        environment: row.environment,
        clientSideToken: row.client_side_token,
        webhookSecretConfigured: true,
        apiKeyConfigured: Boolean(row.api_secret_ciphertext),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
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
    accountId(c),
    id,
    "webhook_secret_ciphertext",
  );
  const apiCiphertext = input.apiKey
    ? await encryptBillingProviderSecret(input.apiKey, c.env, accountId(c), id, "api_secret_ciphertext")
    : null;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO billing_providers (
           id, account_id, provider, environment, client_side_token,
           webhook_secret_ciphertext, api_secret_ciphertext, status, created_at, updated_at
         ) VALUES (?1, ?2, 'paddle', ?3, ?4, ?5, ?6, 'active', ?7, ?7)`,
      ).bind(id, accountId(c), input.environment, input.clientSideToken, webhookCiphertext, apiCiphertext, now),
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
      clientSideToken: input.clientSideToken,
      webhookSecretConfigured: true,
      apiKeyConfigured: Boolean(input.apiKey),
      status: "active",
    },
  }, 201);
});

adminBillingRouter.patch("/providers/:providerId", requireRole(["owner", "admin"]), async (c) => {
  const input = ProviderPatchSchema.parse(await c.req.json());
  const provider = await getProvider(c.env.DB, accountId(c), c.req.param("providerId"));
  if (!provider) throw new NotFoundError("Billing Provider not found.");
  if ((input.provider && input.provider !== provider.provider) ||
      (input.environment && input.environment !== provider.environment)) {
    throw new AppError(
      "BILLING_PROVIDER_IDENTITY_IMMUTABLE",
      "Provider and environment cannot be changed; create another connection.",
      409,
      { providerId: provider.id, provider: provider.provider, environment: provider.environment },
    );
  }
  const clientToken = input.clientSideToken ?? provider.client_side_token;
  assertPaddleClientTokenForRoute(provider.environment, clientToken);
  const webhookCiphertext = input.webhookSecret
    ? await encryptBillingProviderSecret(input.webhookSecret, c.env, provider.account_id, provider.id, "webhook_secret_ciphertext")
    : provider.webhook_secret_ciphertext;
  const apiCiphertext = input.apiKey === undefined
    ? provider.api_secret_ciphertext
    : input.apiKey === null
      ? null
      : await encryptBillingProviderSecret(input.apiKey, c.env, provider.account_id, provider.id, "api_secret_ciphertext");
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE billing_providers
       SET client_side_token = ?1, webhook_secret_ciphertext = ?2,
           api_secret_ciphertext = ?3, status = ?4, updated_at = ?5
       WHERE account_id = ?6 AND id = ?7`,
    ).bind(clientToken, webhookCiphertext, apiCiphertext, input.status ?? provider.status, now, provider.account_id, provider.id),
    prepareAudit(c, "billing.provider.update", "billing_provider", provider.id, {
      clientSideTokenRotated: input.clientSideToken !== undefined,
      webhookSecretRotated: input.webhookSecret !== undefined,
      apiKeyChanged: input.apiKey !== undefined,
      status: input.status ?? provider.status,
    }),
  ]);
  return c.json({ success: true, data: { id: provider.id, updatedAt: now } });
});

adminBillingRouter.post("/providers/:providerId/test", requireRole(["owner", "admin"]), async (c) => {
  const input = ProviderTestSchema.parse(await c.req.json().catch(() => ({})));
  const provider = await getProvider(c.env.DB, accountId(c), c.req.param("providerId"));
  if (!provider) throw new NotFoundError("Billing Provider not found.");
  assertPaddleClientTokenForRoute(provider.environment, provider.client_side_token);
  const secret = await decryptBillingProviderWebhookSecret(provider, c.env);
  const signatureValid = input.rawBody
    ? await verifyPaddleWebhookSignature(input.rawBody, input.paddleSignature, secret)
    : null;
  if (signatureValid === false) {
    throw new AppError("BILLING_PROVIDER_SIGNATURE_SAMPLE_INVALID", "Paddle signature sample did not verify.", 400, {
      provider: "paddle", environment: provider.environment,
    });
  }
  return c.json({
    success: true,
    data: {
      provider: "paddle",
      environment: provider.environment,
      clientSideTokenValid: true,
      webhookSecretDecryptable: secret.length > 0,
      signatureSampleVerified: signatureValid,
      apiKeyConfigured: Boolean(provider.api_secret_ciphertext),
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
       ON plan.account_id = offer.account_id AND plan.id = offer.license_plan_id
     JOIN billing_providers AS provider
       ON provider.account_id = offer.account_id AND provider.id = offer.billing_provider_id
     WHERE offer.account_id = ?1
     ORDER BY offer.created_at DESC
     LIMIT 100`,
  ).bind(accountId(c)).all<Record<string, unknown>>();
  return c.json({ success: true, data: { items: result.results } });
});

adminBillingRouter.post("/offers", requireRole(["owner", "admin"]), async (c) => {
  const input = OfferCreateSchema.parse(await c.req.json());
  const account = accountId(c);
  await assertOfferMapping(c.env.DB, account, input);
  const id = `off_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO billing_offers (
           id, account_id, billing_provider_id, external_price_id,
           product_id, license_plan_id, purchase_type, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?8)`,
      ).bind(id, account, input.billingProviderId, input.externalPriceId, input.productId, input.licensePlanId, input.purchaseType, now),
      prepareAudit(c, "billing.offer.create", "billing_offer", id, input),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new AppError("BILLING_OFFER_PRICE_ALREADY_MAPPED", "This Paddle Price is already mapped.", 409, {
        billingProviderId: input.billingProviderId, externalPriceId: input.externalPriceId,
      });
    }
    throw error;
  }
  return c.json({ success: true, data: { id, status: "draft" } }, 201);
});

adminBillingRouter.patch("/offers/:offerId", requireRole(["owner", "admin"]), async (c) => {
  const input = OfferPatchSchema.parse(await c.req.json());
  const account = accountId(c);
  const current = await c.env.DB.prepare(
    `SELECT billing_provider_id, external_price_id, product_id, license_plan_id, purchase_type, status
     FROM billing_offers WHERE account_id = ?1 AND id = ?2 LIMIT 1`,
  ).bind(account, c.req.param("offerId")).first<any>();
  if (!current) throw new NotFoundError("Billing Offer not found.");
  if (current.status !== "draft") {
    throw new AppError("BILLING_OFFER_NOT_EDITABLE", "Only draft Offers can be edited.", 409);
  }
  const verification = await c.env.DB.prepare(
    `SELECT id FROM billing_checkout_verifications
     WHERE account_id = ?1 AND billing_offer_id = ?2 LIMIT 1`,
  ).bind(account, c.req.param("offerId")).first<{ id: string }>();
  if (verification) {
    throw new AppError("BILLING_OFFER_VERIFICATION_EXISTS", "Archive this Offer and create another mapping.", 409, {
      offerId: c.req.param("offerId"), verificationId: verification.id,
    });
  }
  const merged = {
    billingProviderId: input.billingProviderId ?? current.billing_provider_id,
    externalPriceId: input.externalPriceId ?? current.external_price_id,
    productId: input.productId ?? current.product_id,
    licensePlanId: input.licensePlanId ?? current.license_plan_id,
    purchaseType: input.purchaseType ?? current.purchase_type,
  };
  await assertOfferMapping(c.env.DB, account, merged);
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE billing_offers
       SET billing_provider_id = ?1, external_price_id = ?2, product_id = ?3,
           license_plan_id = ?4, purchase_type = ?5, updated_at = ?6
       WHERE account_id = ?7 AND id = ?8 AND status = 'draft'`,
    ).bind(merged.billingProviderId, merged.externalPriceId, merged.productId, merged.licensePlanId,
      merged.purchaseType, now, account, c.req.param("offerId")),
    prepareAudit(c, "billing.offer.update", "billing_offer", c.req.param("offerId"), merged),
  ]);
  return c.json({ success: true, data: { id: c.req.param("offerId"), status: "draft", updatedAt: now } });
});

adminBillingRouter.post("/offers/:offerId/verification-config", requireRole(["owner", "admin"]), async (c) => {
  const account = accountId(c);
  const row = await c.env.DB.prepare(
    `SELECT offer.id, offer.external_price_id, offer.purchase_type,
            product.slug AS product_slug, product.name AS product_name,
            product.description AS product_description,
            plan.name AS offer_name, provider.environment, provider.client_side_token
     FROM billing_offers AS offer
     JOIN products AS product ON product.account_id = offer.account_id AND product.id = offer.product_id
     JOIN license_plans AS plan ON plan.account_id = offer.account_id AND plan.id = offer.license_plan_id
     JOIN billing_providers AS provider
       ON provider.account_id = offer.account_id AND provider.id = offer.billing_provider_id
     WHERE offer.account_id = ?1 AND offer.id = ?2
       AND offer.status = 'draft' AND provider.status = 'active'
       AND provider.environment = 'sandbox'
     LIMIT 1`,
  ).bind(account, c.req.param("offerId")).first<any>();
  if (!row) {
    throw new AppError(
      "BILLING_CHECKOUT_VERIFICATION_UNAVAILABLE",
      "Checkout verification requires an active Paddle Sandbox Provider and a draft Offer.",
      409,
      { offerId: c.req.param("offerId") },
    );
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `vfy_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const tokenHash = await sha256Hex(token);
  const id = `bcv_${ulid().toLowerCase()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO billing_checkout_verifications (
         id, account_id, billing_offer_id, requested_by_user_id,
         token_hash, status, expires_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?7)`,
    ).bind(id, account, row.id, c.get("userId"), tokenHash, expiresAt, now.toISOString()),
    prepareAudit(c, "billing.checkout_verification.create", "billing_checkout_verification", id, {
      offerId: row.id, expiresAt,
    }),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({
    success: true,
    data: {
      verificationMode: true,
      verificationToken: token,
      expiresAt,
      product: { slug: row.product_slug, name: row.product_name, description: row.product_description ?? undefined },
      checkout: { available: true, provider: "paddle", environment: "sandbox", clientSideToken: row.client_side_token },
      offers: [{
        id: row.id,
        name: row.offer_name,
        purchaseType: row.purchase_type,
        priceId: row.external_price_id,
        quantity: 1,
      }],
    },
  }, 201);
});

adminBillingRouter.post("/offers/:offerId/activate", requireRole(["owner", "admin"]), async (c) => {
  const account = accountId(c);
  const row = await getBillingOfferReadinessRow(c.env.DB, account, c.req.param("offerId"));
  if (!row) throw new NotFoundError("Billing Offer not found.");
  if (row.offer_status !== "draft") {
    throw new AppError("BILLING_OFFER_NOT_DRAFT", "Only a draft Offer can be activated.", 409);
  }
  const readiness = await evaluateBillingOfferReadiness(c.env.DB, row, {
    activation: true,
    schedulerStore: c.env.KEYS_KV,
  });
  if (!readiness.ready) {
    throw new AppError(
      "BILLING_CHECKOUT_NOT_READY",
      "Checkout dependencies are not ready.",
      409,
      { offerId: row.id, checks: readiness.checks },
    );
  }
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE billing_offers SET status = 'active', updated_at = ?1
       WHERE account_id = ?2 AND id = ?3 AND status = 'draft'`,
    ).bind(now, account, row.id),
    prepareAudit(c, "billing.offer.activate", "billing_offer", row.id, { checks: readiness.checks }),
  ]);
  return c.json({ success: true, data: { id: row.id, status: "active", readiness } });
});

adminBillingRouter.post("/offers/:offerId/archive", requireRole(["owner", "admin"]), async (c) => {
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE billing_offers SET status = 'archived', updated_at = ?1
     WHERE account_id = ?2 AND id = ?3 AND status <> 'archived'`,
  ).bind(now, accountId(c), c.req.param("offerId")).run();
  if (!result.meta.changes) throw new NotFoundError("Billing Offer not found or already archived.");
  await c.env.DB.batch([prepareAudit(c, "billing.offer.archive", "billing_offer", c.req.param("offerId"), {})]);
  return c.json({ success: true, data: { id: c.req.param("offerId"), status: "archived" } });
});

adminBillingRouter.get("/customers", requireRole(["owner", "admin", "member", "viewer"]), async (c) => listBillingRows(c, "billing_customers", "updated_at"));
adminBillingRouter.get("/subscriptions", requireRole(["owner", "admin", "member", "viewer"]), async (c) => listBillingRows(c, "billing_subscriptions", "updated_at"));
adminBillingRouter.get("/events", requireRole(["owner", "admin", "member", "viewer"]), async (c) => listBillingRows(c, "inbound_events", "received_at"));
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
      accountId: accountId(c),
      billingCustomerId: c.req.param("billingCustomerId"),
    });
  } catch (error) {
    asBillingRouteError(error);
  }
  return c.json({ success: true, data: result });
});

adminBillingRouter.post("/events/:eventId/replay", requireRole(["owner", "admin"]), async (c) => {
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE inbound_events
     SET status = 'pending', next_attempt_at = ?1, locked_by = NULL, locked_until = NULL,
         last_error_code = NULL, last_error_detail = NULL, updated_at = ?1
     WHERE account_id = ?2 AND id = ?3
       AND status IN ('failed', 'needs_attention')
       AND payload_ciphertext IS NOT NULL
       AND payload_expires_at > ?1`,
  ).bind(now, accountId(c), c.req.param("eventId")).run();
  if (!result.meta.changes) {
    throw new AppError(
      "BILLING_EVENT_NOT_REPLAYABLE",
      "Event is not in a replayable state or its encrypted payload expired.",
      409,
      { eventId: c.req.param("eventId") },
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
  const account = accountId(c);
  const adjustment = await c.env.DB.prepare(
    `SELECT id, license_id, review_status
     FROM billing_adjustments
     WHERE account_id = ?1 AND id = ?2
     LIMIT 1`,
  ).bind(account, c.req.param("adjustmentId")).first<{
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
  if (adjustment.license_id && input.action === "reinstate") {
    statements.push(c.env.DB.prepare(
      `UPDATE licenses SET status = 'active', status_reason = NULL, suspended_at = NULL, updated_at = ?1
       WHERE account_id = ?2 AND id = ?3 AND is_checkout_verification = 0`,
    ).bind(now.toISOString(), account, adjustment.license_id));
  } else if (adjustment.license_id && input.action === "revoke") {
    statements.push(c.env.DB.prepare(
      `UPDATE licenses SET status = 'revoked', status_reason = 'billing_adjustment', revoked_at = ?1, updated_at = ?1
       WHERE account_id = ?2 AND id = ?3 AND is_checkout_verification = 0`,
    ).bind(now.toISOString(), account, adjustment.license_id));
  } else if (adjustment.license_id && input.action === "security_reset") {
    const userId = c.get("userId");
    if (!userId) throw new AppError("ADMIN_USER_CONTEXT_MISSING", "Authenticated user context is required.", 500);
    const rotation = await prepareLicenseKeyRotation({
      db: c.env.DB,
      env: c.env,
      accountId: account,
      licenseId: adjustment.license_id,
      actor: { type: "user", id: userId },
      reason: "security_reset",
      requestId: c.get("requestId"),
      ip: c.req.header("cf-connecting-ip"),
      userAgent: c.req.header("user-agent"),
      now,
    });
    statements.push(...rotation.statements);
  }
  statements.push(c.env.DB.prepare(
    `UPDATE billing_adjustments
     SET review_status = 'resolved', resolution_action = ?1, resolution_reason = ?2,
         resolved_by_user_id = ?3, resolved_at = ?4, updated_at = ?4
     WHERE account_id = ?5 AND id = ?6 AND review_status = 'open'`,
  ).bind(input.action, input.reason, c.get("userId"), now.toISOString(), account, adjustment.id));
  statements.push(prepareAudit(c, "billing.adjustment.resolve", "billing_adjustment", adjustment.id, {
    action: input.action, reason: input.reason, licenseId: adjustment.license_id,
  }));
  await c.env.DB.batch(statements);
  return c.json({ success: true, data: { id: adjustment.id, reviewStatus: "resolved", resolutionAction: input.action } });
});

async function getProvider(db: D1Database, account: string, providerId: string): Promise<BillingProviderRecord | null> {
  const row = await db.prepare(
    `SELECT id, account_id, provider, environment, client_side_token,
            webhook_secret_ciphertext, api_secret_ciphertext, status, created_at, updated_at
     FROM billing_providers WHERE account_id = ?1 AND id = ?2 LIMIT 1`,
  ).bind(account, providerId).first<BillingProviderRecord>();
  return row ?? null;
}

async function assertOfferMapping(
  db: D1Database,
  account: string,
  input: z.infer<typeof OfferCreateSchema>,
): Promise<void> {
  const row = await db.prepare(
    `SELECT provider.provider, provider.environment, provider.status AS provider_status,
            product.status AS product_status, plan.status AS plan_status,
            plan.license_model
     FROM billing_providers AS provider
     JOIN products AS product ON product.account_id = provider.account_id AND product.id = ?3
     JOIN license_plans AS plan
       ON plan.account_id = product.account_id AND plan.product_id = product.id AND plan.id = ?4
     WHERE provider.account_id = ?1 AND provider.id = ?2
     LIMIT 1`,
  ).bind(account, input.billingProviderId, input.productId, input.licensePlanId).first<any>();
  if (!row) throw new AppError("BILLING_OFFER_RELATION_INVALID", "Provider, Product, and License Plan must belong to this Account and Product.", 400);
  if (row.provider !== "paddle") throw new AppError("BILLING_PROVIDER_UNSUPPORTED", "Only Paddle is implemented in V1.", 400);
  const validType = input.purchaseType === "subscription"
    ? row.license_model === "subscription"
    : row.license_model === "perpetual" || row.license_model === "fixed_term";
  if (!validType) throw new AppError("BILLING_OFFER_PURCHASE_TYPE_MISMATCH", "Offer purchase type does not match the License Plan model.", 400, {
    purchaseType: input.purchaseType, licenseModel: row.license_model,
  });
}

async function listBillingRows(c: any, table: string, orderColumn: string): Promise<Response> {
  const requestedLimit = Number(c.req.query("limit") ?? 50);
  const requestedOffset = Number(c.req.query("offset") ?? 0);
  if (!Number.isInteger(requestedLimit) || !Number.isInteger(requestedOffset)) {
    throw new AppError("VALIDATION_ERROR", "limit and offset must be integers.", 400);
  }
  const limit = Math.min(100, Math.max(1, requestedLimit));
  const offset = Math.max(0, requestedOffset);
  const allowed = new Set(["billing_customers", "billing_subscriptions", "inbound_events", "billing_adjustments"]);
  if (!allowed.has(table)) throw new Error("Unsupported billing table");
  const result = await (c.env.DB as D1Database).prepare(
    `SELECT * FROM ${table} WHERE account_id = ?1 ORDER BY ${orderColumn} DESC LIMIT ?2 OFFSET ?3`,
  ).bind(accountId(c), limit, offset).all<Record<string, unknown>>();
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
  const row = await (c.env.DB as D1Database).prepare(`SELECT * FROM ${table} WHERE account_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(accountId(c), id).first<Record<string, unknown>>();
  if (!row) throw new NotFoundError("Billing resource not found.");
  const data = { ...row };
  hidden.forEach((field) => delete data[field]);
  return c.json({ success: true, data });
}
