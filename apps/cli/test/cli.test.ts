import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getMachineFingerprint } from "../src/lib/machine";
import {
  saveStoredLicense,
  loadStoredLicense,
  clearStoredLicense,
  type StoredLicenseData,
} from "../src/lib/storage";
import {
  verifyOfflineToken,
  evaluateLicenseClaims,
  bufferToBase64,
  base64ToBuffer,
  type OfflineLicenseClaims,
} from "../src/lib/crypto";

describe("LicenKit CLI - Machine Fingerprint", () => {
  it("should extract a persistent, non-empty hardware fingerprint", async () => {
    const fp1 = await getMachineFingerprint();
    const fp2 = await getMachineFingerprint();

    expect(fp1).toBeDefined();
    expect(typeof fp1).toBe("string");
    expect(fp1.length).toBeGreaterThanOrEqual(8);
    // Deterministic across multiple calls
    expect(fp1).toBe(fp2);
  });
});

describe("LicenKit CLI - Local License Storage", () => {
  const tempConfigDir = path.join(os.tmpdir(), `licenkit-test-${Date.now()}`);

  beforeEach(() => {
    process.env.LICENKIT_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempConfigDir)) {
      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("should save, load, and clear stored license data correctly", () => {
    expect(loadStoredLicense()).toBeNull();

    const sampleData: StoredLicenseData = {
      serverUrl: "http://localhost:8787",
      accountId: "acc_demo_01",
      productId: "prd_super_app",
      licenseKey: "LIC-ABCD-1234-EFGH-5678",
      token: "header.payload.signature",
      publicKey: "pubkey_base64_test",
      machineId: "mac_001",
      tokenExpiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
      policy: {
        name: "Pro Tier",
        maxMachines: 2,
        offlineGracePeriod: 2592000,
        features: ["export", "sync"],
      },
    };

    saveStoredLicense(sampleData);

    const loaded = loadStoredLicense();
    expect(loaded).toBeDefined();
    expect(loaded?.licenseKey).toBe(sampleData.licenseKey);
    expect(loaded?.policy?.name).toBe("Pro Tier");
    expect(loaded?.policy?.features).toEqual(["export", "sync"]);

    const cleared = clearStoredLicense();
    expect(cleared).toBe(true);
    expect(loadStoredLicense()).toBeNull();
  });
});

describe("LicenKit CLI - Offline Cryptographic Token Verification", () => {
  // Helper to generate keypair and sign token using WebCrypto native
  async function createTestSignedToken(claims: OfflineLicenseClaims): Promise<{
    token: string;
    publicKeyBase64: string;
  }> {
    const keyPair = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    )) as any;

    const rawPub = (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer;
    const publicKeyBase64 = bufferToBase64(rawPub);

    const header = { alg: "Ed25519", typ: "LK-TOKEN", kid: "kid_test_01" };
    const headerB64Url = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const claimsB64Url = btoa(JSON.stringify(claims)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const dataToSign = `${headerB64Url}.${claimsB64Url}`;

    const encoder = new TextEncoder();
    const signatureBuffer = await crypto.subtle.sign(
      "Ed25519",
      keyPair.privateKey,
      encoder.encode(dataToSign) as any
    );
    const signatureBase64 = bufferToBase64(signatureBuffer);
    const signatureB64Url = signatureBase64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

    const token = `${headerB64Url}.${claimsB64Url}.${signatureB64Url}`;
    return { token, publicKeyBase64 };
  }

  it("should mathematically verify genuine offline token without network access", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims: OfflineLicenseClaims = {
      typ: "license",
      lic_id: "lic_offline_test",
      sub: "LIC-OFFL-TEST-0001",
      acc: "acc_test",
      prd: "prd_test",
      pol: "pol_test",
      fp: "mac-hardware-uuid-12345",
      iat: nowSec,
      exp: nowSec + 3600, // Valid for 1h
      fea: ["pro_export", "gpu_acceleration"],
    };

    const { token, publicKeyBase64 } = await createTestSignedToken(claims);

    const res = await verifyOfflineToken<OfflineLicenseClaims>(token, publicKeyBase64);
    expect(res.valid).toBe(true);
    expect(res.claims).toBeDefined();
    expect(res.claims?.sub).toBe("LIC-OFFL-TEST-0001");
    expect(res.claims?.fea).toEqual(["pro_export", "gpu_acceleration"]);

    // Test evaluation against matching fingerprint
    const evalValid = evaluateLicenseClaims(res.claims!, "mac-hardware-uuid-12345");
    expect(evalValid.valid).toBe(true);
    expect(evalValid.isFingerprintMatch).toBe(true);
    expect(evalValid.isExpired).toBe(false);

    // Test evaluation with granted feature
    const evalFeature = evaluateLicenseClaims(res.claims!, "mac-hardware-uuid-12345", "pro_export");
    expect(evalFeature.valid).toBe(true);

    // Test evaluation with missing feature
    const evalMissingFeature = evaluateLicenseClaims(res.claims!, "mac-hardware-uuid-12345", "enterprise_sso");
    expect(evalMissingFeature.valid).toBe(false);
  });

  it("should fail evaluation when machine fingerprint does not match host (Anti-Copy Protection)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims: OfflineLicenseClaims = {
      typ: "license",
      lic_id: "lic_stolen",
      sub: "LIC-COPY-STOLEN-0001",
      acc: "acc_test",
      prd: "prd_test",
      pol: "pol_test",
      fp: "device_A_hardware_uuid",
      iat: nowSec,
      exp: nowSec + 3600,
      fea: ["pro"],
    };

    const { token, publicKeyBase64 } = await createTestSignedToken(claims);
    const res = await verifyOfflineToken<OfflineLicenseClaims>(token, publicKeyBase64);
    expect(res.valid).toBe(true);

    // Host machine is device_B, but token is bound to device_A
    const evalResult = evaluateLicenseClaims(res.claims!, "device_B_hardware_uuid");
    expect(evalResult.valid).toBe(false);
    expect(evalResult.isFingerprintMatch).toBe(false);
    expect(evalResult.reasons.some((r) => r.includes("fingerprint mismatch"))).toBe(true);
  });

  it("should fail evaluation when token is past expiration timestamp", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims: OfflineLicenseClaims = {
      typ: "license",
      lic_id: "lic_expired",
      sub: "LIC-EXPIRED-TOKEN",
      acc: "acc_test",
      prd: "prd_test",
      pol: "pol_test",
      fp: "device_uuid_99",
      iat: nowSec - 7200,
      exp: nowSec - 100, // Expired 100 seconds ago
      fea: ["basic"],
    };

    const { token, publicKeyBase64 } = await createTestSignedToken(claims);
    const res = await verifyOfflineToken<OfflineLicenseClaims>(token, publicKeyBase64);
    expect(res.valid).toBe(true);

    const evalResult = evaluateLicenseClaims(res.claims!, "device_uuid_99");
    expect(evalResult.valid).toBe(false);
    expect(evalResult.isExpired).toBe(true);
    expect(evalResult.reasons.some((r) => r.includes("expired"))).toBe(true);
  });

  it("should fail cryptographic verification when token signature or payload is tampered", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims: OfflineLicenseClaims = {
      typ: "license",
      lic_id: "lic_tamper",
      sub: "LIC-TAMPER-0001",
      acc: "acc_test",
      prd: "prd_test",
      pol: "pol_test",
      fp: "device_uuid",
      iat: nowSec,
      exp: nowSec + 3600,
      fea: ["free_tier"],
    };

    const { token, publicKeyBase64 } = await createTestSignedToken(claims);
    const parts = token.split(".");
    // Tamper with payload
    const tamperedPayload = btoa(JSON.stringify({ ...claims, fea: ["unlimited_enterprise"] }));
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const res = await verifyOfflineToken(tamperedToken, publicKeyBase64);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Cryptographic signature verification failed");
  });
});
