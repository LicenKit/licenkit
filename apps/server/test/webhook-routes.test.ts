import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import {
  encryptEnvelope,
  computeHmacSha256,
} from "../src/infra/crypto";
import * as schema from "../src/infra/db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";

describe("Payment Webhook Routes - Inbound Fulfillment & Idempotency", () => {
  let testEnv: TestEnvContext;
  let db: any;

  const accountId = "acc_test_workspace_01";
  const productId = "prd_super_app_01";
  const paddleSecret = "pdl_ntfsec_test_secret_key_1234567890";
  const stripeSecret = "whsec_test_stripe_secret_key_abcdef123456";
  const lemonSecret = "lemon_signing_secret_test_999";

  beforeEach(async () => {
    testEnv = createTestEnv();
    db = drizzle(testEnv.d1, { schema });

    const now = new Date().toISOString();
    const masterKey = testEnv.env.STORAGE_ENCRYPTION_KEY!;

    // 1. Seed Account with encrypted payment configuration
    const paymentConfigsPlain = JSON.stringify({
      paddle: { webhook_secret: paddleSecret },
      stripe: { webhook_secret: stripeSecret },
      lemonsqueezy: { webhook_secret: lemonSecret },
    });
    const encryptedConfigs = await encryptEnvelope(paymentConfigsPlain, masterKey);

    await db.insert(schema.accounts).values({
      id: accountId,
      name: "Acme Test Corp",
      slug: "acme-corp",
      paymentConfigs: encryptedConfigs,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Seed Product
    await db.insert(schema.products).values({
      id: productId,
      accountId,
      name: "Super App Pro",
      trialDays: 14,
      trialFeatures: "[]",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    // 3. Seed Policies for Paddle, Stripe and Lemon Squeezy
    await db.insert(schema.policies).values([
      {
        id: "pol_paddle_monthly",
        accountId,
        productId,
        name: "Paddle Monthly Pro",
        duration: 2592000, // 30 days
        offlineGracePeriod: 2592000,
        maxMachines: 2,
        scheme: "ed25519",
        features: JSON.stringify(["pro_features", "paddle_perk"]),
        metadata: JSON.stringify({ paddle_price_id: "pri_paddle_pro_30d" }),
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "pol_stripe_annual",
        accountId,
        productId,
        name: "Stripe Annual Enterprise",
        duration: 31536000, // 365 days
        offlineGracePeriod: 2592000,
        maxMachines: 5,
        scheme: "ed25519",
        features: JSON.stringify(["enterprise_features"]),
        metadata: JSON.stringify({ stripe_price_id: "price_stripe_enterprise_1y" }),
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "pol_lemon_tier",
        accountId,
        productId,
        name: "Lemon Squeezy Pro Tier",
        duration: 2592000,
        offlineGracePeriod: 2592000,
        maxMachines: 1,
        scheme: "ed25519",
        features: JSON.stringify(["lemon_perk"]),
        metadata: JSON.stringify({ lemonsqueezy_variant_id: "variant_lemon_123" }),
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // 4. Seed Outbound Webhook Endpoint to verify event broadcasting
    await db.insert(schema.webhookEndpoints).values({
      id: "whe_outbound_test",
      accountId,
      productId: "*",
      url: "https://example.com/webhook-sink",
      secret: "whsec_outbound_secret_sink",
      events: JSON.stringify(["*"]),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  describe("Paddle Billing Inbound Webhooks", () => {
    it("should process transaction.completed, match policy by price ID, and issue license", async () => {
      const payload = JSON.stringify({
        event_id: "evt_pad_txn_1001",
        event_type: "transaction.completed",
        data: {
          id: "txn_paddle_999",
          subscription_id: "sub_paddle_888",
          customer: { email: "paddle_buyer@example.com" },
          items: [{ price: { id: "pri_paddle_pro_30d" } }],
        },
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const signature = await computeHmacSha256(`${nowSec}:${payload}`, paddleSecret);
      const sigHeader = `ts=${nowSec};h1=${signature}`;

      const res = await app.request(
        `/api/v1/webhooks/paddle/${accountId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Paddle-Signature": sigHeader,
          },
          body: payload,
        },
        testEnv.env
      );

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.fulfillment.action).toBe("license_issued");
      expect(body.data.fulfillment.licenseId).toBeDefined();

      // Verify License Record in D1
      const issuedLicense = await db
        .select()
        .from(schema.licenses)
        .where(eq(schema.licenses.id, body.data.fulfillment.licenseId))
        .get();

      expect(issuedLicense).toBeDefined();
      expect(issuedLicense.customerEmail).toBe("paddle_buyer@example.com");
      expect(issuedLicense.policyId).toBe("pol_paddle_monthly");
      expect(issuedLicense.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect((issuedLicense as any).key).toBeUndefined();

      // Verify Outbound Broadcast was pushed to queue
      expect(testEnv.sentQueueMessages.length).toBeGreaterThan(0);
      const sentMsg = testEnv.sentQueueMessages.find((m) =>
        m.payload.includes("license.created")
      );
      expect(sentMsg).toBeDefined();
    });

    it("should enforce 3D idempotency when duplicate event is received", async () => {
      const payload = JSON.stringify({
        event_id: "evt_pad_duplicate_test",
        event_type: "transaction.completed",
        data: {
          id: "txn_pad_dup_1",
          customer: { email: "duplicate_tester@example.com" },
          items: [{ price_id: "pri_paddle_pro_30d" }],
        },
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const signature = await computeHmacSha256(`${nowSec}:${payload}`, paddleSecret);
      const sigHeader = `ts=${nowSec};h1=${signature}`;

      // First Request
      const res1 = await app.request(
        `/api/v1/webhooks/paddle/${accountId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Paddle-Signature": sigHeader },
          body: payload,
        },
        testEnv.env
      );
      expect(res1.status).toBe(200);

      // Second Request (Identical event_id)
      const res2 = await app.request(
        `/api/v1/webhooks/paddle/${accountId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Paddle-Signature": sigHeader },
          body: payload,
        },
        testEnv.env
      );

      expect(res2.status).toBe(200);
      const body2: any = await res2.json();
      expect(body2.success).toBe(true);
      expect(body2.message).toBe("Duplicate event already processed");

      // Verify only 1 license exists for this customer
      const countResult = await db
        .select()
        .from(schema.licenses)
        .where(eq(schema.licenses.customerEmail, "duplicate_tester@example.com"))
        .all();

      expect(countResult.length).toBe(1);
    });

    it("should revoke license when subscription.canceled event arrives", async () => {
      // First, manually seed an existing active license linked to sub_pad_cancel_me
      const licenseId = "lic_pad_to_cancel";
      await db.insert(schema.licenses).values({
        id: licenseId,
        accountId,
        productId,
        policyId: "pol_paddle_monthly",
        keyHash: "hash_pad_cancel",
        customerEmail: "subscriber@example.com",
        status: "active",
        metadata: JSON.stringify({ external_subscription_id: "sub_pad_cancel_me" }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const cancelPayload = JSON.stringify({
        event_id: "evt_pad_sub_cancel_01",
        event_type: "subscription.canceled",
        data: {
          id: "sub_pad_cancel_me",
        },
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const signature = await computeHmacSha256(`${nowSec}:${cancelPayload}`, paddleSecret);
      const sigHeader = `ts=${nowSec};h1=${signature}`;

      const res = await app.request(
        `/api/v1/webhooks/paddle/${accountId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Paddle-Signature": sigHeader },
          body: cancelPayload,
        },
        testEnv.env
      );

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.fulfillment.action).toBe("license_revoked");

      // Check updated status in D1
      const updatedLicense = await db
        .select()
        .from(schema.licenses)
        .where(eq(schema.licenses.id, licenseId))
        .get();

      expect(updatedLicense.status).toBe("revoked");
    });
  });

  describe("Stripe Inbound Webhooks", () => {
    it("should process checkout.session.completed and issue license via price ID pushdown", async () => {
      const payload = JSON.stringify({
        id: "evt_stripe_checkout_01",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_stripe_test_session",
            customer_email: "stripe_vip@example.com",
            metadata: {
              stripe_price_id: "price_stripe_enterprise_1y",
            },
          },
        },
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const signature = await computeHmacSha256(`${nowSec}.${payload}`, stripeSecret);
      const sigHeader = `t=${nowSec},v1=${signature}`;

      const res = await app.request(
        `/api/v1/webhooks/stripe/${accountId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Stripe-Signature": sigHeader,
          },
          body: payload,
        },
        testEnv.env
      );

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.fulfillment.action).toBe("license_issued");

      const issued = await db
        .select()
        .from(schema.licenses)
        .where(eq(schema.licenses.customerEmail, "stripe_vip@example.com"))
        .get();

      expect(issued).toBeDefined();
      expect(issued.policyId).toBe("pol_stripe_annual");
      expect(issued.expiresAt).toBeDefined();
    });

    it("should revoke license on customer.subscription.deleted event", async () => {
      const licenseId = "lic_stripe_sub_active";
      await db.insert(schema.licenses).values({
        id: licenseId,
        accountId,
        productId,
        policyId: "pol_stripe_annual",
        keyHash: "hash_stripe_sub",
        customerEmail: "sub_deleted@example.com",
        status: "active",
        metadata: JSON.stringify({ external_subscription_id: "sub_stripe_del_99" }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const payload = JSON.stringify({
        id: "evt_str_sub_del",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_stripe_del_99",
          },
        },
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const signature = await computeHmacSha256(`${nowSec}.${payload}`, stripeSecret);
      const sigHeader = `t=${nowSec},v1=${signature}`;

      const res = await app.request(
        `/api/v1/webhooks/stripe/${accountId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Stripe-Signature": sigHeader },
          body: payload,
        },
        testEnv.env
      );

      expect(res.status).toBe(200);

      const target = await db
        .select()
        .from(schema.licenses)
        .where(eq(schema.licenses.id, licenseId))
        .get();

      expect(target.status).toBe("revoked");
    });
  });

  describe("Lemon Squeezy Inbound Webhooks", () => {
    it("should process order_created and issue license matched by variant_id pushdown", async () => {
      const payload = JSON.stringify({
        meta: {
          event_name: "order_created",
          event_id: "evt_lemon_order_1001",
          custom_data: {},
        },
        data: {
          id: "10099",
          type: "orders",
          attributes: {
            user_email: "lemon_buyer@example.com",
            first_order_item: {
              variant_id: "variant_lemon_123",
            },
          },
        },
      });

      const signature = await computeHmacSha256(payload, lemonSecret);

      const res = await app.request(
        `/api/v1/webhooks/lemonsqueezy/${accountId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-signature": signature,
          },
          body: payload,
        },
        testEnv.env
      );

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.fulfillment.action).toBe("license_issued");

      const issued = await db
        .select()
        .from(schema.licenses)
        .where(eq(schema.licenses.customerEmail, "lemon_buyer@example.com"))
        .get();

      expect(issued).toBeDefined();
      expect(issued.policyId).toBe("pol_lemon_tier");
      expect(issued.status).toBe("active");
    });

    it("should enforce 3D idempotency when duplicate Lemon Squeezy order is received", async () => {
      const payload = JSON.stringify({
        meta: {
          event_name: "order_created",
          event_id: "evt_lemon_dup_1002",
        },
        data: {
          id: "10100",
          type: "orders",
          attributes: {
            user_email: "lemon_dup_buyer@example.com",
            first_order_item: {
              variant_id: "variant_lemon_123",
            },
          },
        },
      });

      const signature = await computeHmacSha256(payload, lemonSecret);

      // First call
      const res1 = await app.request(
        `/api/v1/webhooks/lemonsqueezy/${accountId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-signature": signature },
          body: payload,
        },
        testEnv.env
      );
      expect(res1.status).toBe(200);

      // Duplicate call
      const res2 = await app.request(
        `/api/v1/webhooks/lemonsqueezy/${accountId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-signature": signature },
          body: payload,
        },
        testEnv.env
      );

      expect(res2.status).toBe(200);
      const body2: any = await res2.json();
      expect(body2.success).toBe(true);
      expect(body2.message).toBe("Duplicate event already processed");

      const count = await db
        .select()
        .from(schema.licenses)
        .where(eq(schema.licenses.customerEmail, "lemon_dup_buyer@example.com"))
        .all();

      expect(count.length).toBe(1);
    });

    it("should revoke license on subscription_cancelled event", async () => {
      const licenseId = "lic_lemon_sub_cancel";
      await db.insert(schema.licenses).values({
        id: licenseId,
        accountId,
        productId,
        policyId: "pol_lemon_tier",
        keyHash: "hash_lemon_sub",
        customerEmail: "lemon_sub_cancel@example.com",
        status: "active",
        metadata: JSON.stringify({ external_subscription_id: "lemon_sub_9988" }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const payload = JSON.stringify({
        meta: {
          event_name: "subscription_cancelled",
          event_id: "evt_lemon_sub_cancel_01",
        },
        data: {
          id: "lemon_sub_9988",
          type: "subscriptions",
        },
      });

      const signature = await computeHmacSha256(payload, lemonSecret);

      const res = await app.request(
        `/api/v1/webhooks/lemonsqueezy/${accountId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-signature": signature },
          body: payload,
        },
        testEnv.env
      );

      expect(res.status).toBe(200);

      const target = await db
        .select()
        .from(schema.licenses)
        .where(eq(schema.licenses.id, licenseId))
        .get();

      expect(target.status).toBe("revoked");
    });
  });

  describe("Security & Fail-Fast Error Branches", () => {
    it("should reject webhook request with invalid signature (HTTP 401)", async () => {
      const payload = JSON.stringify({ event: "test" });
      const res = await app.request(
        `/api/v1/webhooks/paddle/${accountId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Paddle-Signature": "ts=12345678;h1=fake_tampered_signature_hex",
          },
          body: payload,
        },
        testEnv.env
      );

      expect(res.status).toBe(401);
      const body: any = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("INVALID_SIGNATURE");
    });

    it("should return HTTP 404 when account does not exist", async () => {
      const payload = JSON.stringify({ event: "test" });
      const res = await app.request(
        `/api/v1/webhooks/paddle/non_existent_account_id`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        },
        testEnv.env
      );

      expect(res.status).toBe(404);
    });

    it("should reject unsupported provider (HTTP 400)", async () => {
      const res = await app.request(
        `/api/v1/webhooks/paypal/${accountId}`,
        {
          method: "POST",
          body: "{}",
        },
        testEnv.env
      );

      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe("INVALID_PROVIDER");
    });
  });
});
