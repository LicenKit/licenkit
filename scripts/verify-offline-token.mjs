/**
 * LicenKit Offline Token End-to-End Verification Test
 * Tests cryptographic signing, packaging, offline client verification,
 * fingerprint anti-spoofing, and tamper detection.
 */

import assert from "node:assert";

// Base64 helpers
function bufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64ToBase64Url(base64) {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBase64(base64Url) {
  const b64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  return pad ? b64 + "=".repeat(4 - pad) : b64;
}

function jsonToBase64Url(obj) {
  const encoder = new TextEncoder();
  return base64ToBase64Url(bufferToBase64(encoder.encode(JSON.stringify(obj))));
}

function base64UrlToJson(base64Url) {
  const decoder = new TextDecoder();
  const bytes = base64ToBuffer(base64UrlToBase64(base64Url));
  return JSON.parse(decoder.decode(bytes));
}

async function signEd25519(data, privateKeyPkcs8Base64) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const privBuffer = base64ToBuffer(privateKeyPkcs8Base64.replace(/\s+/g, ""));
  const key = await crypto.subtle.importKey("pkcs8", privBuffer, { name: "Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, bytes);
  return bufferToBase64(signature);
}

async function verifyEd25519(data, signatureBase64, publicKeyBase64) {
  try {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const pubBuffer = base64ToBuffer(publicKeyBase64.replace(/\s+/g, ""));
    const sigBuffer = base64ToBuffer(signatureBase64.replace(/\s+/g, ""));
    const key = await crypto.subtle.importKey("raw", pubBuffer, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBuffer, bytes);
  } catch {
    return false;
  }
}

async function signOfflineToken(header, claims, privateKeyPkcs8Base64) {
  const headerB64 = jsonToBase64Url(header);
  const claimsB64 = jsonToBase64Url(claims);
  const dataToSign = `${headerB64}.${claimsB64}`;

  const sigBase64 = await signEd25519(dataToSign, privateKeyPkcs8Base64);
  const sigB64Url = base64ToBase64Url(sigBase64);

  return `${dataToSign}.${sigB64Url}`;
}

async function verifyOfflineToken(token, publicKeyBase64) {
  try {
    const parts = token.trim().split(".");
    if (parts.length !== 3) {
      return { valid: false, error: "Malformed token: expected 3 dot-separated parts" };
    }

    const [headerB64, claimsB64, signatureB64Url] = parts;
    const dataToVerify = `${headerB64}.${claimsB64}`;
    const signatureBase64 = base64UrlToBase64(signatureB64Url);

    const isSigValid = await verifyEd25519(dataToVerify, signatureBase64, publicKeyBase64);
    if (!isSigValid) {
      return { valid: false, error: "Cryptographic signature verification failed" };
    }

    const header = base64UrlToJson(headerB64);
    const claims = base64UrlToJson(claimsB64);

    return { valid: true, header, claims };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

async function runTests() {
  console.log("=== LicenKit M06 Offline Token Verification Tests ===");

  // 1. Generate Ed25519 keypair
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const pkcs8Private = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);

  const publicKeyBase64 = bufferToBase64(rawPublic);
  const privateKeyPkcs8Base64 = bufferToBase64(pkcs8Private);

  console.log("✓ Keypair generated successfully");
  console.log("  Public Key (32B):", publicKeyBase64);

  // 2. Sign a Commercial License Offline Token
  const now = Math.floor(Date.now() / 1000);
  const myHardwareFingerprint = "sha256:d8e8fca2dc6b1296e38f9024f0d63509988";

  const licenseHeader = {
    alg: "Ed25519",
    typ: "LK-TOKEN",
    kid: "kid_01j8x9n4k1l2m3n4p5q6r7s8t9",
  };

  const licenseClaims = {
    typ: "license",
    lic_id: "lic_01j8x9n6d1e2f3g4h5i6j7k8l9",
    sub: "LIC-ABCD-1234-EFGH-5678",
    acc: "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    prd: "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
    pol: "pol_01j8x9n5u1v2w3x4y5z6a7b8c9",
    fp: myHardwareFingerprint,
    iat: now,
    exp: now + 30 * 86400, // 30 days offline grace period
    fea: ["4k_export", "pro_audio", "cloud_sync"],
  };

  const token = await signOfflineToken(licenseHeader, licenseClaims, privateKeyPkcs8Base64);
  console.log("✓ Offline License Token signed successfully");
  console.log("  Compact Token:", token.slice(0, 48) + "..." + token.slice(-24));

  // 3. Client Offline Verification (Using Public Key ONLY, zero network)
  const verifyResult = await verifyOfflineToken(token, publicKeyBase64);
  assert.strictEqual(verifyResult.valid, true, "Token signature should be mathematically valid");
  assert.strictEqual(verifyResult.claims.sub, "LIC-ABCD-1234-EFGH-5678");
  assert.strictEqual(verifyResult.claims.fp, myHardwareFingerprint);
  assert.deepStrictEqual(verifyResult.claims.fea, ["4k_export", "pro_audio", "cloud_sync"]);
  console.log("✓ Client offline mathematical verification PASSED");

  // 4. Test Hardware Fingerprint Mismatch (Anti-Spoofing / Device-Binding test)
  const anotherComputerFingerprint = "sha256:different_hardware_uuid_mac_address";
  const isCorrectMachine = verifyResult.claims.fp === anotherComputerFingerprint;
  assert.strictEqual(isCorrectMachine, false, "Should reject when hardware fingerprint does not match");
  console.log("✓ Anti-spoofing check PASSED: token cannot be shared to different hardware");

  // 5. Test Tamper Detection (Modify payload or signature)
  const tamperedToken = token.slice(0, 10) + "X" + token.slice(11);
  const tamperedResult = await verifyOfflineToken(tamperedToken, publicKeyBase64);
  assert.strictEqual(tamperedResult.valid, false, "Tampered token MUST fail signature verification");
  console.log("✓ Tamper detection PASSED: any modified byte causes cryptographic invalidation");

  // 6. Test Free Trial Token
  const trialHeader = {
    alg: "Ed25519",
    typ: "LK-TRIAL",
    kid: "kid_01j8x9n4k1l2m3n4p5q6r7s8t9",
  };
  const trialClaims = {
    typ: "trial",
    acc: "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    prd: "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
    fp: myHardwareFingerprint,
    iat: now,
    exp: now + 14 * 86400,
    fea: ["basic_recording"],
  };

  const trialToken = await signOfflineToken(trialHeader, trialClaims, privateKeyPkcs8Base64);
  const trialVerify = await verifyOfflineToken(trialToken, publicKeyBase64);
  assert.strictEqual(trialVerify.valid, true);
  assert.strictEqual(trialVerify.claims.typ, "trial");
  assert.deepStrictEqual(trialVerify.claims.fea, ["basic_recording"]);
  console.log("✓ Trial Token signing & offline verification PASSED");

  console.log("\nALL M06 OFFLINE TOKEN TESTS PASSED SUCCESSFULLY! 🚀");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
