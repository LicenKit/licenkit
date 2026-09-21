import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  apiActivate,
  apiDeactivate,
  ClientApiError,
  ClientTransportError,
  requestClientApi,
  type ClientCredentialResponse,
} from "../src/lib/client-api";
import {
  bufferToBase64,
  evaluateSignedLicenseClaims,
  verifySignedLicenseToken,
  type SignedLicenseClaims,
} from "../src/lib/crypto";
import { verifyCredentialResponse } from "../src/lib/credentials";
import { clearStoredLicense, loadStoredLicense, saveStoredLicense } from "../src/lib/storage";

function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return bytes.toString("base64url");
}

async function signedToken(overrides: Partial<SignedLicenseClaims> = {}) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "licenkit-license+jwt", kid: "key_v1" };
  const claims: SignedLicenseClaims = {
    lic: "lic_1",
    act: "act_1",
    ins: "ins_1",
    prd: "prd_1",
    rel: "rel_1",
    ver: "2.4.0",
    plt: "macos-arm64",
    rat: now - 100,
    fp: "device-fingerprint",
    iat: now - 100,
    exp: now + 3600,
    lexp: null,
    upd: now + 1000,
    fea: ["export"],
    ...overrides,
  };
  const headerPart = base64url(JSON.stringify(header));
  const claimsPart = base64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, Buffer.from(`${headerPart}.${claimsPart}`));
  return {
    token: `${headerPart}.${claimsPart}.${base64url(new Uint8Array(signature))}`,
    publicKey: bufferToBase64(await crypto.subtle.exportKey("raw", keys.publicKey)),
    claims,
  };
}

describe("V1 client API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends instance, product, device and immutable release identity", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    await apiActivate({
      serverUrl: "https://license.example.com",
      instanceId: "ins_1",
      productId: "prd_1",
      licenseKey: "LK-SECRET",
      fingerprint: "fp",
      devicePlatform: "macos-arm64",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
    });
    expect(body).toMatchObject({
      instance_id: "ins_1",
      product_id: "prd_1",
      device_platform: "macos-arm64",
      release_version: "2.4.0",
      release_platform: "macos-universal",
    });
  });

  it("uses the strict deactivate payload without release-only fields", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        success: true,
        data: { activation_id: "act_1", status: "deactivated" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await apiDeactivate({
      serverUrl: "https://license.example.com",
      instanceId: "ins_1",
      productId: "prd_1",
      activationId: "act_1",
      machineToken: "mtk_secret",
      fingerprint: "fp",
    });
    expect(body).toEqual({
      instance_id: "ins_1",
      product_id: "prd_1",
      activation_id: "act_1",
      machine_token: "mtk_secret",
      fingerprint: "fp",
    });
  });

  it("preserves business error code, request ID and safe details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: {
        code: "UPDATE_ENTITLEMENT_REQUIRED",
        message: "Update entitlement ended",
        request_id: "req_1",
        details: { release_version: "2.4.0", machine_token: "secret" },
      },
    }), { status: 403, headers: { "content-type": "application/json" } })));
    await expect(requestClientApi("https://license.example.com", "/api/v1/client/validate"))
      .rejects.toMatchObject({
        code: "UPDATE_ENTITLEMENT_REQUIRED",
        requestId: "req_1",
        details: { release_version: "2.4.0", machine_token: "[REDACTED]" },
      });
  });

  it("keeps server 5xx separate from business rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: { code: "DATABASE_UNAVAILABLE", message: "retry later", request_id: "req_2" },
    }), { status: 503, headers: { "content-type": "application/json" } })));
    await expect(requestClientApi("https://license.example.com", "/api/v1/client/validate"))
      .rejects.toMatchObject({ kind: "server", serverCode: "DATABASE_UNAVAILABLE", requestId: "req_2" });
  });
});

describe("V1 signed and opaque credentials", () => {
  it("allows opaque mode with no signing key", async () => {
    const response: ClientCredentialResponse = {
      activation_id: "act_1",
      machine_token: "mtk_secret",
      credential_mode: "opaque",
      signed_license_token: null,
      license_expires_at: null,
      terms: { max_activations: 1, features: [], updates_until: null },
    };
    await expect(verifyCredentialResponse(response, {}, {
      instanceId: "ins_1", productId: "prd_1", activationId: "act_1", fingerprint: "fp",
      releaseVersion: "1.0", releasePlatform: "macos-arm64",
    })).resolves.toBeUndefined();
  });

  it("requires the configured key ID and verifies all signed claims", async () => {
    const signed = await signedToken();
    const response: ClientCredentialResponse = {
      activation_id: "act_1",
      machine_token: "mtk_secret",
      credential_mode: "signed",
      signed_license_token: signed.token,
      signing_key_id: "key_v1",
      license_expires_at: null,
      terms: { max_activations: 1, features: ["export"], updates_until: null },
    };
    await expect(verifyCredentialResponse(response, {}, {
      instanceId: "ins_1", productId: "prd_1", activationId: "act_1", fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0", releasePlatform: "macos-arm64",
    })).rejects.toMatchObject({ code: "TRUSTED_SIGNING_KEY_MISSING" });
    await expect(verifyCredentialResponse(response, { key_v1: signed.publicKey }, {
      instanceId: "ins_1", productId: "prd_1", activationId: "act_1", fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0", releasePlatform: "macos-arm64",
    })).resolves.toMatchObject({ lic: "lic_1", rel: "rel_1" });
  });

  it("rejects the removed acc Claim and reports Instance mismatches explicitly", async () => {
    const legacy = await signedToken({ ins: "", acc: "acc_1" } as unknown as Partial<SignedLicenseClaims>);
    await expect(verifySignedLicenseToken(legacy.token, legacy.publicKey))
      .rejects.toMatchObject({ code: "TOKEN_CLAIMS_INVALID" });

    const current = await signedToken();
    const verified = await verifySignedLicenseToken(current.token, current.publicKey);
    expect(evaluateSignedLicenseClaims(verified.claims, {
      instanceId: "ins_other", productId: "prd_1", activationId: "act_1", fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0", releasePlatform: "macos-arm64",
    })).toMatchObject({ valid: false, code: "TOKEN_INSTANCE_MISMATCH" });
  });

  it("rejects release builds after updates_until independently of expiration", async () => {
    const signed = await signedToken({ rat: 2_000, upd: 1_999, lexp: null });
    const verified = await verifySignedLicenseToken(signed.token, signed.publicKey);
    expect(evaluateSignedLicenseClaims(verified.claims, {
      instanceId: "ins_1", productId: "prd_1", activationId: "act_1", fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0", releasePlatform: "macos-arm64",
    })).toMatchObject({ valid: false, code: "UPDATE_ENTITLEMENT_REQUIRED" });
  });
});

describe("V1 local credential storage", () => {
  const configDir = path.join(os.tmpdir(), `licenkit-v1-cli-${process.pid}`);
  beforeEach(() => {
    process.env.LICENKIT_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    delete process.env.LICENKIT_CONFIG_DIR;
  });

  it("stores machine credentials without the activation license key", () => {
    saveStoredLicense({
      serverUrl: "https://license.example.com",
      instanceId: "ins_1",
      productId: "prd_1",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-arm64",
      devicePlatform: "macos-arm64",
      activationId: "act_1",
      machineToken: "mtk_secret",
      credentialMode: "opaque",
      activatedAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      licenseExpiresAt: null,
      terms: { max_activations: 1, features: [], updates_until: null },
    });
    const loaded = loadStoredLicense();
    expect(loaded?.activationId).toBe("act_1");
    expect((loaded as unknown as Record<string, unknown>)?.licenseKey).toBeUndefined();
    expect(clearStoredLicense()).toBe(true);
  });
});
