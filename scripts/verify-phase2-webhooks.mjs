/**
 * Automated Verification Script: Phase 2 Webhook Signatures, Fulfillment & Queue Broadcast
 * Tests Paddle-Signature, Stripe-Signature, Lemon Squeezy signature, Crockford license key format,
 * anti-replay timestamp drift, and outbound HMAC-SHA256 signature.
 */

import {
  computeHmacSha256,
  verifyHmacSha256,
  verifyPaddleSignature,
  verifyStripeSignature,
  verifyLemonSqueezySignature,
  computeOutboundWebhookSignature,
  verifyOutboundWebhookSignature,
  generateLicenseKey,
} from "../apps/server/src/infra/crypto/index.ts";

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function runTests() {
  console.log("\n=======================================================");
  console.log("🚀 Running Phase 2 Inbound & Outbound Webhook Test Suite");
  console.log("=======================================================\n");

  const secretPaddle = "pdl_ntf_set_01h8testpaddlekey99";
  const secretStripe = "whsec_teststripesecretkey882244";
  const secretLemon = "lemonsqueezy_secret_test_key";
  const rawBody = JSON.stringify({
    event_id: "evt_test_123456",
    event_type: "transaction.completed",
    data: { id: "txn_01h8test", customer_id: "ctm_01h8" },
  });

  // --- 1. Test Paddle-Signature ---
  console.log("--- 1. Testing Paddle Billing Signature (Paddle-Signature) ---");
  const currentTs = Math.floor(Date.now() / 1000);
  const paddleDataToSign = `${currentTs}:${rawBody}`;
  const paddleH1 = await computeHmacSha256(paddleDataToSign, secretPaddle);
  const validPaddleHeader = `ts=${currentTs};h1=${paddleH1}`;

  const paddleValid = await verifyPaddleSignature(rawBody, validPaddleHeader, secretPaddle);
  assert(paddleValid === true, "Valid Paddle signature header verified successfully");

  const paddleTamperedBody = rawBody + " ";
  const paddleTampered = await verifyPaddleSignature(paddleTamperedBody, validPaddleHeader, secretPaddle);
  assert(paddleTampered === false, "Tampered body correctly rejected by Paddle verifier");

  const paddleWrongSecret = await verifyPaddleSignature(rawBody, validPaddleHeader, "wrong_secret");
  assert(paddleWrongSecret === false, "Wrong secret correctly rejected by Paddle verifier");

  // Replay attack / Drift test (> 300s)
  const expiredTs = currentTs - 350;
  const expiredDataToSign = `${expiredTs}:${rawBody}`;
  const expiredH1 = await computeHmacSha256(expiredDataToSign, secretPaddle);
  const expiredPaddleHeader = `ts=${expiredTs};h1=${expiredH1}`;
  const paddleExpired = await verifyPaddleSignature(rawBody, expiredPaddleHeader, secretPaddle, 300);
  assert(paddleExpired === false, "Expired timestamp (> 300s) correctly rejected for anti-replay");

  // --- 2. Test Stripe-Signature ---
  console.log("\n--- 2. Testing Stripe Signature (Stripe-Signature) ---");
  const stripeDataToSign = `${currentTs}.${rawBody}`;
  const stripeV1 = await computeHmacSha256(stripeDataToSign, secretStripe);
  const validStripeHeader = `t=${currentTs},v1=${stripeV1}`;

  const stripeValid = await verifyStripeSignature(rawBody, validStripeHeader, secretStripe);
  assert(stripeValid === true, "Valid Stripe signature header verified successfully");

  // Rolling secret test: multiple v1 headers
  const rollingStripeHeader = `t=${currentTs},v1=invalid_old_signature_12345,v1=${stripeV1}`;
  const stripeRollingValid = await verifyStripeSignature(rawBody, rollingStripeHeader, secretStripe);
  assert(stripeRollingValid === true, "Multiple v1 signatures handled correctly (rolling secrets)");

  const stripeTampered = await verifyStripeSignature(rawBody + "tamper", validStripeHeader, secretStripe);
  assert(stripeTampered === false, "Tampered payload correctly rejected by Stripe verifier");

  const stripeExpiredHeader = `t=${expiredTs},v1=${await computeHmacSha256(`${expiredTs}.${rawBody}`, secretStripe)}`;
  const stripeExpired = await verifyStripeSignature(rawBody, stripeExpiredHeader, secretStripe, 300);
  assert(stripeExpired === false, "Stripe timestamp drift (> 300s) correctly rejected for anti-replay");

  // --- 3. Test Lemon Squeezy Signature ---
  console.log("\n--- 3. Testing Lemon Squeezy Signature (X-Signature) ---");
  const lemonSig = await computeHmacSha256(rawBody, secretLemon);
  const lemonValid = await verifyLemonSqueezySignature(rawBody, lemonSig, secretLemon);
  assert(lemonValid === true, "Valid Lemon Squeezy signature verified successfully");

  const lemonInvalid = await verifyLemonSqueezySignature(rawBody, "invalid_sig", secretLemon);
  assert(lemonInvalid === false, "Invalid Lemon Squeezy signature rejected");

  // --- 4. Test Crockford License Key Generation ---
  console.log("\n--- 4. Testing License Key Generator Format ---");
  const key = generateLicenseKey();
  console.log("  Generated Key sample:", key);
  const keyRegex = /^LIC-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
  assert(keyRegex.test(key), "Generated key complies with Crockford base32 LIC-XXXX-XXXX-XXXX-XXXX standard");

  // Check custom prefix
  const customKey = generateLicenseKey("PRO");
  assert(customKey.startsWith("PRO-"), "Custom prefix supported for key generation");

  // --- 5. Test Outbound Webhook Signature (X-LicenKit-Signature with Anti-Replay) ---
  console.log("\n--- 5. Testing Outbound Event Queue Dispatch Signature (Anti-Replay) ---");
  const outboundSecret = "whsec_0123456789abcdef0123456789abcdef";
  const outboundPayload = JSON.stringify({
    id: "evt_outbound_112233",
    event: "license.created",
    createdAt: new Date().toISOString(),
    data: {
      licenseId: "lic_01h8test",
      key,
      customerEmail: "customer@example.com",
    },
  });

  const { signatureHeader, timestamp, signatureHex } = await computeOutboundWebhookSignature(
    outboundPayload,
    outboundSecret
  );
  assert(signatureHex.length === 64, "Outbound HMAC-SHA256 signature is 64-char hex string");
  assert(signatureHeader.startsWith(`t=${timestamp},v1=`), "Signature header matches t=...,v1=... standard");

  const isOutboundVerified = await verifyOutboundWebhookSignature(
    outboundPayload,
    signatureHeader,
    outboundSecret
  );
  assert(isOutboundVerified === true, "Outbound signature verification succeeds with recipient secret");

  const isTamperedOutboundVerified = await verifyOutboundWebhookSignature(
    outboundPayload + "tamper",
    signatureHeader,
    outboundSecret
  );
  assert(isTamperedOutboundVerified === false, "Tampered outbound webhook payload fails verification");

  // Anti-replay test for outbound signature (> 300s)
  const expiredOutboundTs = timestamp - 350;
  const expiredOutboundSig = await computeOutboundWebhookSignature(
    outboundPayload,
    outboundSecret,
    expiredOutboundTs
  );
  const isExpiredOutboundRejected = await verifyOutboundWebhookSignature(
    outboundPayload,
    expiredOutboundSig.signatureHeader,
    outboundSecret,
    300
  );
  assert(isExpiredOutboundRejected === false, "Expired outbound signature (> 300s) correctly rejected for anti-replay");

  console.log("\n=======================================================");
  console.log("🎉 ALL PHASE 2 WEBHOOK & FULFILLMENT TESTS PASSED 100%");
  console.log("=======================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
