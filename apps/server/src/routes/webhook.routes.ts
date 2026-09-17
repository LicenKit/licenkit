import { Hono } from "hono";
import { ulid } from "ulid";
import { eq, and, sql } from "drizzle-orm";
import type { AppContext } from "../types";
import { getTenantDB } from "../infra/db";
import { accounts, webhookEvents, licenses, policies } from "../infra/db/schema";
import {
  decryptEnvelope,
  getStorageEncryptionKey,
  verifyPaddleSignature,
  verifyStripeSignature,
  verifyLemonSqueezySignature,
  generateLicenseKey,
} from "../infra/crypto";
import { broadcastOutboundEvent } from "../infra/events/broadcast";
import { AppError, NotFoundError } from "../middleware/error";

export const webhookRouter = new Hono<AppContext>();

// POST /api/v1/webhooks/:provider/:account_id
webhookRouter.post("/:provider/:account_id", async (c) => {
  const provider = c.req.param("provider").toLowerCase();
  const accountId = c.req.param("account_id");
  const rawBody = await c.req.text();

  if (!["stripe", "paddle", "lemonsqueezy", "custom"].includes(provider)) {
    throw new AppError("INVALID_PROVIDER", "Unsupported payment provider", 400);
  }

  const db = getTenantDB(c, accountId);

  // 1. Fetch account and payment config
  const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account || !account.isActive) {
    throw new NotFoundError("Account not found or inactive");
  }

  // 2. Decrypt payment config to get webhook secret
  let webhookSecret = "";
  if (account.paymentConfigs) {
    const encKey = getStorageEncryptionKey(c.env);
    try {
      const decrypted = await decryptEnvelope(account.paymentConfigs, encKey);
      const parsed = JSON.parse(decrypted);
      webhookSecret = parsed[provider]?.webhook_secret || "";
    } catch (e: any) {
      console.error(`Failed to decrypt webhook secret for provider ${provider}:`, e);
      throw new AppError(
        "DECRYPTION_FAILED",
        `Failed to decrypt payment configuration for ${provider}. Please verify STORAGE_ENCRYPTION_KEY.`,
        500
      );
    }
  }

  // Strict check: if no webhook secret is configured, reject inbound request to prevent spoofing
  if (!webhookSecret && provider !== "custom") {
    throw new AppError("PAYMENT_CONFIG_MISSING", `Webhook secret for ${provider} is not configured`, 400);
  }

  // 3. Cryptographic Signature Verification
  if (provider === "paddle") {
    const signatureHeader = c.req.header("paddle-signature");
    const isValid = await verifyPaddleSignature(rawBody, signatureHeader, webhookSecret);
    if (!isValid) {
      throw new AppError("INVALID_SIGNATURE", "Paddle signature verification failed", 401);
    }
  } else if (provider === "stripe") {
    const signatureHeader = c.req.header("stripe-signature");
    const isValid = await verifyStripeSignature(rawBody, signatureHeader, webhookSecret);
    if (!isValid) {
      throw new AppError("INVALID_SIGNATURE", "Stripe signature verification failed", 401);
    }
  } else if (provider === "lemonsqueezy") {
    const signatureHeader = c.req.header("x-signature");
    const isValid = await verifyLemonSqueezySignature(rawBody, signatureHeader, webhookSecret);
    if (!isValid) {
      throw new AppError("INVALID_SIGNATURE", "Lemon Squeezy signature verification failed", 401);
    }
  }

  // 4. Parse webhook payload
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new AppError("INVALID_JSON", "Payload is not valid JSON", 400);
  }

  // Extract external event_id and event_type
  let externalEventId: string | null = null;
  let eventType = "unknown";

  if (provider === "paddle") {
    externalEventId = payload.event_id || payload.id || null;
    eventType = payload.event_type || payload.type || "unknown";
  } else if (provider === "stripe") {
    externalEventId = payload.id || null;
    eventType = payload.type || "unknown";
  } else if (provider === "lemonsqueezy") {
    externalEventId = payload.meta?.custom_data?.event_id || payload.data?.id || null;
    eventType = payload.meta?.event_name || "unknown";
  } else {
    externalEventId = payload.id || payload.event_id || null;
    eventType = payload.type || payload.event_type || "unknown";
  }

  // 5. 3D Idempotency Check: (accountId, provider, externalEventId)
  let existingRecord: { id: string; status: string } | null = null;
  if (externalEventId) {
    const existing = await db
      .select({ id: webhookEvents.id, status: webhookEvents.status })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.accountId, accountId),
          eq(webhookEvents.provider, provider),
          eq(webhookEvents.eventId, externalEventId)
        )
      )
      .get();

    if (existing) {
      if (existing.status === "processed") {
        return c.json({ success: true, message: "Duplicate event already processed" }, 200);
      }
      existingRecord = existing;
    }
  }

  const inboundEventId = existingRecord ? existingRecord.id : `evt_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();

  // 6. Pre-reserve inbound event as pending before business fulfillment (Atomic idempotency shield)
  if (existingRecord) {
    await db
      .update(webhookEvents)
      .set({
        status: "pending",
        attempts: sql`${webhookEvents.attempts} + 1`,
        payload: rawBody,
      })
      .where(eq(webhookEvents.id, existingRecord.id));
  } else {
    await db.insert(webhookEvents).values({
      id: inboundEventId,
      accountId,
      provider,
      direction: "inbound",
      eventId: externalEventId,
      eventType,
      payload: rawBody,
      status: "pending",
      attempts: 1,
      createdAt: now,
    });
  }

  // 7. Automated Fulfillment & Business Processing
  let fulfillmentResult: { licenseId?: string; action: string } = { action: "ignored" };

  try {
    if (provider === "paddle") {
      fulfillmentResult = await handlePaddleFulfillment(c.env, db, accountId, eventType, payload);
    } else if (provider === "stripe") {
      fulfillmentResult = await handleStripeFulfillment(c.env, db, accountId, eventType, payload);
    }
  } catch (err: any) {
    console.error(`Fulfillment error for ${provider} event ${eventType}:`, err);
    // Record event as failed for auditing
    await db
      .update(webhookEvents)
      .set({
        status: "failed",
        lastError: err.message || "Fulfillment error",
        processedAt: new Date().toISOString(),
      })
      .where(eq(webhookEvents.id, inboundEventId));

    throw err;
  }

  // 8. Record inbound event as processed
  await db
    .update(webhookEvents)
    .set({
      status: "processed",
      lastError: null,
      processedAt: new Date().toISOString(),
    })
    .where(eq(webhookEvents.id, inboundEventId));

  return c.json({
    success: true,
    data: {
      received: true,
      event_id: inboundEventId,
      fulfillment: fulfillmentResult,
    },
  });
});

/**
 * Handles Paddle Billing events fulfillment:
 * - transaction.completed / transaction.paid: Issue license based on price ID or custom policy ID
 * - subscription.canceled / subscription.past_due: Revoke or suspend matching license
 */
async function handlePaddleFulfillment(
  env: any,
  db: any,
  accountId: string,
  eventType: string,
  payload: any
): Promise<{ licenseId?: string; action: string }> {
  const data = payload.data || {};

  if (eventType === "transaction.completed" || eventType === "transaction.paid") {
    const customData = data.custom_data || {};
    const customerEmail =
      data.customer?.email || customData.customer_email || customData.email || "customer@paddle.com";

    // Extract price IDs from items
    const items = data.items || data.details?.line_items || [];
    const priceIds: string[] = items.map((i: any) => i.price?.id || i.price_id).filter(Boolean);

    // Fetch tenant policies
    const allPolicies = await db
      .select()
      .from(policies)
      .where(and(eq(policies.accountId, accountId), eq(policies.isActive, true)))
      .all();

    let matchedPolicy: typeof policies.$inferSelect | null = null;

    // 1. Match by custom_data.policy_id
    if (customData.policy_id) {
      matchedPolicy = allPolicies.find((p: any) => p.id === customData.policy_id) || null;
    }

    // 2. Match by paddle_price_id in metadata
    if (!matchedPolicy && priceIds.length > 0) {
      for (const p of allPolicies) {
        let meta: Record<string, any> = {};
        try {
          meta = typeof p.metadata === "string" ? JSON.parse(p.metadata || "{}") : p.metadata || {};
        } catch {}

        if (meta.paddle_price_id && priceIds.includes(meta.paddle_price_id)) {
          matchedPolicy = p;
          break;
        }
      }
    }

    // 3. Fallback: single active policy
    if (!matchedPolicy && allPolicies.length === 1) {
      matchedPolicy = allPolicies[0];
    }

    if (!matchedPolicy) {
      return { action: "no_matching_policy" };
    }

    // Secondary Idempotency Shield: check if license already issued for this transaction
    if (data.id) {
      const existingLicense = await db
        .select()
        .from(licenses)
        .where(
          and(
            eq(licenses.accountId, accountId),
            sql`json_extract(${licenses.metadata}, '$.external_transaction_id') = ${data.id}`
          )
        )
        .get();

      if (existingLicense) {
        return { licenseId: existingLicense.id, action: "license_already_issued" };
      }
    }

    // Issue License
    const licenseId = `lic_${ulid().toLowerCase()}`;
    const key = generateLicenseKey();
    const now = new Date();

    let expiresAt: string | null = null;
    if (data.billing_period?.ends_at) {
      expiresAt = new Date(data.billing_period.ends_at).toISOString();
    } else if (matchedPolicy.duration) {
      expiresAt = new Date(now.getTime() + matchedPolicy.duration * 1000).toISOString();
    }

    const metadataObj = {
      external_provider: "paddle",
      external_transaction_id: data.id || null,
      external_subscription_id: data.subscription_id || null,
      external_customer_id: data.customer_id || null,
      ...customData,
    };

    await db.insert(licenses).values({
      id: licenseId,
      accountId,
      productId: matchedPolicy.productId,
      policyId: matchedPolicy.id,
      key,
      customerEmail: customerEmail.toLowerCase().trim(),
      status: "active",
      metadata: JSON.stringify(metadataObj),
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const issuedLicense = {
      id: licenseId,
      key,
      customerEmail,
      productId: matchedPolicy.productId,
      policyId: matchedPolicy.id,
      status: "active",
      expiresAt,
    };

    // Broadcast outbound event
    await broadcastOutboundEvent(
      env,
      db,
      accountId,
      "license.created",
      issuedLicense,
      matchedPolicy.productId
    );

    return { licenseId, action: "license_issued" };
  }

  if (eventType === "subscription.canceled" || eventType === "subscription.past_due") {
    const subscriptionId = data.id;
    if (!subscriptionId) return { action: "no_subscription_id" };

    // Pushdown SQL query: Find license linked to this subscription ID without in-memory full scanning
    const targetLicense = await db
      .select()
      .from(licenses)
      .where(
        and(
          eq(licenses.accountId, accountId),
          sql`(json_extract(${licenses.metadata}, '$.external_subscription_id') = ${subscriptionId} OR json_extract(${licenses.metadata}, '$.externalSubscriptionId') = ${subscriptionId})`
        )
      )
      .get();

    if (!targetLicense) {
      return { action: "subscription_license_not_found" };
    }

    const newStatus = eventType === "subscription.canceled" ? "revoked" : "suspended";
    const nowIso = new Date().toISOString();

    await db
      .update(licenses)
      .set({
        status: newStatus,
        suspendedAt: newStatus === "suspended" ? nowIso : targetLicense.suspendedAt,
        updatedAt: nowIso,
      })
      .where(eq(licenses.id, targetLicense.id));

    const updatedLicense = {
      ...targetLicense,
      status: newStatus,
    };

    await broadcastOutboundEvent(
      env,
      db,
      accountId,
      newStatus === "revoked" ? "license.revoked" : "license.suspended",
      updatedLicense,
      targetLicense.productId
    );

    return { licenseId: targetLicense.id, action: `license_${newStatus}` };
  }

  return { action: "unhandled_event" };
}

/**
 * Handles Stripe events fulfillment:
 * - checkout.session.completed: Issue license based on metadata or matching stripe_price_id
 * - customer.subscription.deleted: Revoke matching license
 */
async function handleStripeFulfillment(
  env: any,
  db: any,
  accountId: string,
  eventType: string,
  payload: any
): Promise<{ licenseId?: string; action: string }> {
  const session = payload.data?.object || {};

  if (eventType === "checkout.session.completed") {
    const customerEmail =
      session.customer_details?.email || session.customer_email || "customer@stripe.com";
    const metadata = session.metadata || {};
    const subscriptionId = session.subscription || null;
    const customerId = session.customer || null;

    const allPolicies = await db
      .select()
      .from(policies)
      .where(and(eq(policies.accountId, accountId), eq(policies.isActive, true)))
      .all();

    let matchedPolicy: typeof policies.$inferSelect | null = null;

    // 1. Match by metadata.policy_id or client_reference_id
    if (metadata.policy_id) {
      matchedPolicy = allPolicies.find((p: any) => p.id === metadata.policy_id) || null;
    } else if (session.client_reference_id) {
      matchedPolicy = allPolicies.find((p: any) => p.id === session.client_reference_id) || null;
    }

    // 2. Match by metadata.stripe_price_id
    if (!matchedPolicy && metadata.stripe_price_id) {
      for (const p of allPolicies) {
        let meta: Record<string, any> = {};
        try {
          meta = typeof p.metadata === "string" ? JSON.parse(p.metadata || "{}") : p.metadata || {};
        } catch {}

        if (meta.stripe_price_id === metadata.stripe_price_id) {
          matchedPolicy = p;
          break;
        }
      }
    }

    // 3. Fallback: single active policy
    if (!matchedPolicy && allPolicies.length === 1) {
      matchedPolicy = allPolicies[0];
    }

    if (!matchedPolicy) {
      return { action: "no_matching_policy" };
    }

    // Secondary Idempotency Shield: check if license already issued for this checkout session
    if (session.id) {
      const existingLicense = await db
        .select()
        .from(licenses)
        .where(
          and(
            eq(licenses.accountId, accountId),
            sql`json_extract(${licenses.metadata}, '$.external_checkout_session_id') = ${session.id}`
          )
        )
        .get();

      if (existingLicense) {
        return { licenseId: existingLicense.id, action: "license_already_issued" };
      }
    }

    // Issue License
    const licenseId = `lic_${ulid().toLowerCase()}`;
    const key = generateLicenseKey();
    const now = new Date();

    let expiresAt: string | null = null;
    if (matchedPolicy.duration) {
      expiresAt = new Date(now.getTime() + matchedPolicy.duration * 1000).toISOString();
    }

    const metadataObj = {
      external_provider: "stripe",
      external_checkout_session_id: session.id || null,
      external_subscription_id: subscriptionId,
      external_customer_id: customerId,
      ...metadata,
    };

    await db.insert(licenses).values({
      id: licenseId,
      accountId,
      productId: matchedPolicy.productId,
      policyId: matchedPolicy.id,
      key,
      customerEmail: customerEmail.toLowerCase().trim(),
      status: "active",
      metadata: JSON.stringify(metadataObj),
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const issuedLicense = {
      id: licenseId,
      key,
      customerEmail,
      productId: matchedPolicy.productId,
      policyId: matchedPolicy.id,
      status: "active",
      expiresAt,
    };

    // Broadcast outbound event
    await broadcastOutboundEvent(
      env,
      db,
      accountId,
      "license.created",
      issuedLicense,
      matchedPolicy.productId
    );

    return { licenseId, action: "license_issued" };
  }

  if (eventType === "customer.subscription.deleted") {
    const subscriptionId = session.id;
    if (!subscriptionId) return { action: "no_subscription_id" };

    // Pushdown SQL query: Find license linked to this subscription ID without in-memory full scanning
    const targetLicense = await db
      .select()
      .from(licenses)
      .where(
        and(
          eq(licenses.accountId, accountId),
          sql`(json_extract(${licenses.metadata}, '$.external_subscription_id') = ${subscriptionId} OR json_extract(${licenses.metadata}, '$.externalSubscriptionId') = ${subscriptionId})`
        )
      )
      .get();

    if (!targetLicense) {
      return { action: "subscription_license_not_found" };
    }

    const nowIso = new Date().toISOString();

    await db
      .update(licenses)
      .set({
        status: "revoked",
        updatedAt: nowIso,
      })
      .where(eq(licenses.id, targetLicense.id));

    const updatedLicense = {
      ...targetLicense,
      status: "revoked",
    };

    await broadcastOutboundEvent(
      env,
      db,
      accountId,
      "license.revoked",
      updatedLicense,
      targetLicense.productId
    );

    return { licenseId: targetLicense.id, action: "license_revoked" };
  }

  return { action: "unhandled_event" };
}
