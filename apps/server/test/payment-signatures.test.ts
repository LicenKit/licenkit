import { describe, it, expect } from "vitest";
import {
  computeHmacSha256,
  verifyPaddleSignature,
  verifyStripeSignature,
  verifyLemonSqueezySignature,
  computeOutboundWebhookSignature,
  verifyOutboundWebhookSignature,
} from "../src/infra/crypto";

describe("Payment Signatures & Anti-Replay Infrastructure", () => {
  const payload = JSON.stringify({
    event_id: "evt_paddle_123456",
    event_type: "transaction.completed",
    data: {
      id: "txn_01j7abc99",
      customer: { email: "buyer@example.com" },
      items: [{ price_id: "pri_pro_monthly" }],
    },
  });

  describe("Paddle Billing Signature Verification (Paddle-Signature)", () => {
    const paddleSecret = "pdl_ntfsec_test_secret_key_1234567890";

    it("should accept valid Paddle signature within tolerance window", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const dataToSign = `${nowSec}:${payload}`;
      const h1 = await computeHmacSha256(dataToSign, paddleSecret);
      const signatureHeader = `ts=${nowSec};h1=${h1}`;

      const isValid = await verifyPaddleSignature(payload, signatureHeader, paddleSecret, 300);
      expect(isValid).toBe(true);
    });

    it("should reject Paddle signature if timestamp is expired (anti-replay attack)", async () => {
      const expiredSec = Math.floor(Date.now() / 1000) - 400; // 400s ago (> 300s tolerance)
      const dataToSign = `${expiredSec}:${payload}`;
      const h1 = await computeHmacSha256(dataToSign, paddleSecret);
      const signatureHeader = `ts=${expiredSec};h1=${h1}`;

      const isValid = await verifyPaddleSignature(payload, signatureHeader, paddleSecret, 300);
      expect(isValid).toBe(false);
    });

    it("should reject Paddle signature if payload is modified or tampered", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const dataToSign = `${nowSec}:${payload}`;
      const h1 = await computeHmacSha256(dataToSign, paddleSecret);
      const signatureHeader = `ts=${nowSec};h1=${h1}`;

      const tamperedPayload = payload.replace("buyer@example.com", "hacker@evil.com");
      const isValid = await verifyPaddleSignature(tamperedPayload, signatureHeader, paddleSecret, 300);
      expect(isValid).toBe(false);
    });

    it("should reject Paddle signature if secret key does not match", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const dataToSign = `${nowSec}:${payload}`;
      const h1 = await computeHmacSha256(dataToSign, paddleSecret);
      const signatureHeader = `ts=${nowSec};h1=${h1}`;

      const isValid = await verifyPaddleSignature(payload, signatureHeader, "wrong_secret", 300);
      expect(isValid).toBe(false);
    });

    it("should reject malformed or missing Paddle header", async () => {
      expect(await verifyPaddleSignature(payload, null, paddleSecret)).toBe(false);
      expect(await verifyPaddleSignature(payload, "invalid_header", paddleSecret)).toBe(false);
      expect(await verifyPaddleSignature(payload, "ts=not_a_number;h1=abc", paddleSecret)).toBe(false);
    });
  });

  describe("Stripe Signature Verification (Stripe-Signature)", () => {
    const stripeSecret = "whsec_test_stripe_secret_key_abcdef123456";

    it("should accept valid Stripe signature with t and v1", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const dataToSign = `${nowSec}.${payload}`;
      const v1 = await computeHmacSha256(dataToSign, stripeSecret);
      const signatureHeader = `t=${nowSec},v1=${v1}`;

      const isValid = await verifyStripeSignature(payload, signatureHeader, stripeSecret, 300);
      expect(isValid).toBe(true);
    });

    it("should accept valid signature when multiple v1 signatures exist (key rotation)", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const dataToSign = `${nowSec}.${payload}`;
      const v1Old = await computeHmacSha256(dataToSign, "whsec_old_retired_key");
      const v1New = await computeHmacSha256(dataToSign, stripeSecret);
      const signatureHeader = `t=${nowSec},v1=${v1Old},v1=${v1New}`;

      const isValid = await verifyStripeSignature(payload, signatureHeader, stripeSecret, 300);
      expect(isValid).toBe(true);
    });

    it("should reject Stripe signature if timestamp is outside tolerance", async () => {
      const expiredSec = Math.floor(Date.now() / 1000) - 500;
      const dataToSign = `${expiredSec}.${payload}`;
      const v1 = await computeHmacSha256(dataToSign, stripeSecret);
      const signatureHeader = `t=${expiredSec},v1=${v1}`;

      const isValid = await verifyStripeSignature(payload, signatureHeader, stripeSecret, 300);
      expect(isValid).toBe(false);
    });

    it("should reject Stripe signature on payload alteration", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const dataToSign = `${nowSec}.${payload}`;
      const v1 = await computeHmacSha256(dataToSign, stripeSecret);
      const signatureHeader = `t=${nowSec},v1=${v1}`;

      const tamperedPayload = payload + " ";
      const isValid = await verifyStripeSignature(tamperedPayload, signatureHeader, stripeSecret, 300);
      expect(isValid).toBe(false);
    });
  });

  describe("Lemon Squeezy Signature Verification (x-signature)", () => {
    const lemonSecret = "lemon_signing_secret_9876543210";

    it("should accept valid Lemon Squeezy HMAC signature", async () => {
      const signature = await computeHmacSha256(payload, lemonSecret);
      const isValid = await verifyLemonSqueezySignature(payload, signature, lemonSecret);
      expect(isValid).toBe(true);
    });

    it("should reject Lemon Squeezy signature if payload is tampered", async () => {
      const signature = await computeHmacSha256(payload, lemonSecret);
      const isValid = await verifyLemonSqueezySignature(payload + "tampered", signature, lemonSecret);
      expect(isValid).toBe(false);
    });

    it("should reject Lemon Squeezy signature on wrong secret", async () => {
      const signature = await computeHmacSha256(payload, lemonSecret);
      const isValid = await verifyLemonSqueezySignature(payload, signature, "wrong_lemon_secret");
      expect(isValid).toBe(false);
    });
  });

  describe("Outbound Webhook Anti-Replay Signature Flow", () => {
    const outboundSecret = "whsec_outbound_client_endpoint_secret_55";

    it("should compute and verify outbound webhook signature successfully", async () => {
      const { signatureHeader, timestamp, signatureHex } = await computeOutboundWebhookSignature(
        payload,
        outboundSecret
      );

      expect(signatureHeader).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      expect(timestamp).toBeGreaterThan(0);
      expect(signatureHex).toHaveLength(64);

      const isValid = await verifyOutboundWebhookSignature(payload, signatureHeader, outboundSecret, 300);
      expect(isValid).toBe(true);
    });

    it("should reject outbound signature when timestamp exceeds tolerance window", async () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 350;
      const { signatureHeader } = await computeOutboundWebhookSignature(
        payload,
        outboundSecret,
        oldTimestamp
      );

      const isValid = await verifyOutboundWebhookSignature(payload, signatureHeader, outboundSecret, 300);
      expect(isValid).toBe(false);
    });

    it("should reject outbound signature when payload has been modified", async () => {
      const { signatureHeader } = await computeOutboundWebhookSignature(payload, outboundSecret);

      const tampered = payload.replace("evt_paddle_123456", "evt_injected_666");
      const isValid = await verifyOutboundWebhookSignature(tampered, signatureHeader, outboundSecret, 300);
      expect(isValid).toBe(false);
    });
  });
});
