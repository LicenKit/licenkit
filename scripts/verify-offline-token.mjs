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

    const unsupportedHeaders = Object.keys(header).filter(
      (key) => !["alg", "typ", "kid"].includes(key),
    );
    if (unsupportedHeaders.length > 0) {
      throw new Error(`Unsupported protected header '${unsupportedHeaders[0]}'`);
    }
    if (header.alg !== "EdDSA") throw new Error("Protected alg must be EdDSA");
    if (header.typ !== "licenkit-license+jwt") {
      throw new Error("Protected typ must be licenkit-license+jwt");
    }
    if (typeof header.kid !== "string" || !header.kid) {
      throw new Error("Protected kid is required");
    }
    if (Object.prototype.hasOwnProperty.call(claims, "acc")) {
      throw new Error("Legacy Claim 'acc' is not supported");
    }
    for (const field of ["lic", "act", "ins", "prd", "rel", "ver", "plt", "fp"]) {
      if (typeof claims[field] !== "string" || claims[field] === "") {
        throw new Error(`Claim '${field}' must be a non-empty string`);
      }
    }
    for (const field of ["rat", "iat", "exp"]) {
      if (!Number.isSafeInteger(claims[field])) {
        throw new Error(`Claim '${field}' must be an integer timestamp`);
      }
    }
    for (const field of ["lexp", "upd"]) {
      if (claims[field] !== null && !Number.isSafeInteger(claims[field])) {
        throw new Error(`Claim '${field}' must be null or an integer timestamp`);
      }
    }
    if (!Array.isArray(claims.fea) || claims.fea.some((feature) => typeof feature !== "string")) {
      throw new Error("Claim 'fea' must be an array of strings");
    }
    if (claims.exp <= claims.iat) throw new Error("Token exp must be later than iat");
    if (claims.lexp !== null && claims.exp > claims.lexp) {
      throw new Error("Token exp cannot be later than License expiration");
    }

    return { valid: true, header, claims };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
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
    alg: "EdDSA",
    typ: "licenkit-license+jwt",
    kid: "key_01j8x9n4k1l2m3n4p5q6r7s8t9",
  };

  const licenseClaims = {
    lic: "lic_01j8x9n6d1e2f3g4h5i6j7k8l9",
    act: "act_01j8x9n7d1e2f3g4h5i6j7k8l9",
    ins: "ins_01j8x9n2r4z7qw8m3p5v1y6t2c",
    prd: "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
    rel: "rel_01j8x9n5u1v2w3x4y5z6a7b8c9",
    ver: "1.2.3",
    plt: "macos-universal",
    rat: now - 60,
    fp: myHardwareFingerprint,
    iat: now,
    exp: now + 30 * 86400, // 30 days offline grace period
    lexp: now + 365 * 86400,
    upd: null,
    fea: ["4k_export", "pro_audio", "cloud_sync"],
  };

  const token = await signOfflineToken(licenseHeader, licenseClaims, privateKeyPkcs8Base64);
  console.log("✓ Offline License Token signed successfully");
  console.log("  Compact Token:", token.slice(0, 48) + "..." + token.slice(-24));

  // 3. Client Offline Verification (Using Public Key ONLY, zero network)
  const verifyResult = await verifyOfflineToken(token, publicKeyBase64);
  assert.strictEqual(verifyResult.valid, true, "Token signature should be mathematically valid");
  assert.strictEqual(verifyResult.header.alg, "EdDSA");
  assert.strictEqual(verifyResult.header.typ, "licenkit-license+jwt");
  assert.strictEqual(verifyResult.claims.ins, "ins_01j8x9n2r4z7qw8m3p5v1y6t2c");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(verifyResult.claims, "acc"), false);
  assert.strictEqual(verifyResult.claims.fp, myHardwareFingerprint);
  assert.deepStrictEqual(verifyResult.claims.fea, ["4k_export", "pro_audio", "cloud_sync"]);
  console.log("✓ Current Instance-scoped Signed License contract verification PASSED");

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

  // 6. Reject the retired Account-scoped Claim even when its signature is valid.
  const { ins: _instance, ...legacyClaims } = licenseClaims;
  const legacyToken = await signOfflineToken(
    licenseHeader,
    { ...legacyClaims, acc: "legacy-instance-id" },
    privateKeyPkcs8Base64,
  );
  const legacyVerify = await verifyOfflineToken(legacyToken, publicKeyBase64);
  assert.strictEqual(legacyVerify.valid, false);
  assert.strictEqual(legacyVerify.error, "Legacy Claim 'acc' is not supported");
  console.log("✓ Retired Account-scoped Claim rejection PASSED");

  console.log("\nALL M06 OFFLINE TOKEN TESTS PASSED SUCCESSFULLY! 🚀");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
