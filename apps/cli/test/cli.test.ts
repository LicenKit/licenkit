import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  apiActivate,
  apiDeactivate,
  apiValidate,
  ClientContractError,
  requestClientApi,
  type ActivationResponse,
  type ActiveLicenseState,
  type CredentialUpdate,
} from "../src/lib/client-api";
import {
  bufferToBase64,
  evaluateSignedLicenseClaims,
  verifySignedLicenseToken,
  type SignedLicenseClaims,
} from "../src/lib/crypto";
import {
  verifyActivationResponse,
  verifyValidationCredentialUpdate,
} from "../src/lib/credentials";
import { verifyCommand } from "../src/commands/verify";
import { validateCommand } from "../src/commands/validate";
import { clearStoredLicense, getLicenseFilePath, loadStoredLicense, saveStoredLicense } from "../src/lib/storage";

function base64url(data: Uint8Array | string): string {
  return Buffer.from(data).toString("base64url");
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
    plt: "macos-universal",
    rat: now - 100,
    fp: "device-fingerprint",
    iat: now,
    exp: now + 3600,
    lexp: null,
    upd: now + 1000,
    fea: ["export"],
    ...overrides,
  };
  const headerPart = base64url(JSON.stringify(header));
  const claimsPart = base64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, Buffer.from(headerPart + "." + claimsPart));
  return {
    token: headerPart + "." + claimsPart + "." + base64url(new Uint8Array(signature)),
    publicKey: bufferToBase64(await crypto.subtle.exportKey("raw", keys.publicKey)),
    claims,
  };
}

function validation(validatedAt = "2026-09-23T10:00:00Z", interval: number | null = null) {
  return { validation_interval_seconds: interval, validated_at: validatedAt };
}

function activeState(): ActiveLicenseState {
  return {
    kind: "license",
    status: "active",
    expires_at: null,
    terms: {
      max_activations: 3,
      features: ["export"],
      updates_until: "2027-09-19T10:00:00Z",
    },
  };
}

function opaqueActivationData(): ActivationResponse {
  const state = activeState();
  return {
    activation_id: "act_1",
    machine_token: "mtk_secret_value_123",
    credential_mode: "opaque",
    signed_license_token: null,
    signed_license_token_expires_at: null,
    signing_key_id: null,
    license_expires_at: null,
    terms: state.terms,
    state,
    validation: validation(),
    meta: { request_id: "req_activate" },
  };
}

describe("unified Client API contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the strict License credential union without legacy top-level or device fields", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        success: true,
        data: {
          state: activeState(),
          credential_update: {
            credential_mode: "opaque",
            signed_license_token: null,
            signed_license_token_expires_at: null,
            signing_key_id: null,
          },
          validation: validation(),
          meta: { request_id: "req_validate" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await apiValidate({
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      credential: {
        kind: "license",
        activation_id: "act_1",
        machine_token: "mtk_secret_value_123",
      },
    });

    expect(body).toEqual({
      product_id: "prd_1",
      fingerprint: "device-fingerprint",
      release_version: "2.4.0",
      release_platform: "macos-universal",
      credential: {
        kind: "license",
        activation_id: "act_1",
        machine_token: "mtk_secret_value_123",
      },
    });
    expect(result.state).toMatchObject({ kind: "license", status: "active" });
    expect(result.validation.validation_interval_seconds).toBeNull();
    expect(result.meta.request_id).toBe("req_validate");
  });

  it("supports Trial and no-credential request variants without the removed trials/validate route", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      const credential = body.credential as { kind: string };
      const state = credential.kind === "trial"
        ? { kind: "trial", status: "expired", code: "TRIAL_EXPIRED", expires_at: "2026-09-23T09:00:00Z" }
        : {
            kind: "activation_required",
            trial: { status: "unavailable", reason: "already_claimed", code: "TRIAL_ALREADY_CLAIMED" },
          };
      return new Response(JSON.stringify({
        success: true,
        data: { state, validation: validation(), meta: { request_id: "req_union" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const context = {
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
    };
    await apiValidate({
      ...context,
      credential: { kind: "trial", trial_id: "trl_1", trial_token: "ttk_secret_value_123" },
    });
    await apiValidate({ ...context, credential: { kind: "none" } });

    expect(calls.map((call) => call.url)).toEqual([
      "https://license.example.com/api/v1/client/validate",
      "https://license.example.com/api/v1/client/validate",
    ]);
    expect(calls.map((call) => call.body.credential)).toEqual([
      { kind: "trial", trial_id: "trl_1", trial_token: "ttk_secret_value_123" },
      { kind: "none" },
    ]);
  });

  it("parses unavailable License and Release states as successful business results with original details", async () => {
    const states = [
      {
        kind: "license",
        status: "expired",
        code: "LICENSE_EXPIRED",
        expires_at: "2026-09-23T09:00:00Z",
        details: {
          billing_period_expires_at: "2026-09-22T09:00:00Z",
          payment_grace_seconds: 86400,
        },
      },
      {
        kind: "release_not_eligible",
        status: "update_required",
        code: "UPDATE_ENTITLEMENT_REQUIRED",
        release_version: "2.4.0",
        release_platform: "macos-universal",
        updates_until: "2026-09-01T00:00:00Z",
        released_at: "2026-09-20T00:00:00Z",
      },
    ];
    let index = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        state: states[index++],
        validation: validation(),
        meta: { request_id: "req_terminal" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const params = {
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      credential: {
        kind: "license" as const,
        activation_id: "act_1",
        machine_token: "mtk_secret_value_123",
      },
    };

    await expect(apiValidate(params)).resolves.toMatchObject({
      state: {
        status: "expired",
        code: "LICENSE_EXPIRED",
        details: { payment_grace_seconds: "86400" },
      },
    });
    await expect(apiValidate(params)).resolves.toMatchObject({
      state: {
        status: "update_required",
        code: "UPDATE_ENTITLEMENT_REQUIRED",
        released_at: "2026-09-20T00:00:00Z",
      },
    });
  });

  it("keeps request ID and HTTP status when a success payload violates the contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { state: { kind: "made_up" } },
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_header" },
    })));
    await expect(apiValidate({
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      credential: { kind: "none" },
    })).rejects.toMatchObject({
      name: "ClientContractError",
      status: 200,
      requestId: "req_header",
    });
  });

  it("rejects an active License response without credential_update", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        state: activeState(),
        validation: validation(),
        meta: { request_id: "req_missing_update" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(apiValidate({
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      credential: { kind: "none" },
    })).rejects.toMatchObject({
      name: "ClientContractError",
      requestId: "req_missing_update",
    });
  });

  it("preserves and field-redacts failed error envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: {
        code: "ACTIVATION_CREDENTIALS_INVALID",
        message: "Credentials do not match",
        request_id: "req_error",
        details: {
          release_version: "2.4.0",
          machine_token: "secret",
          nested: { authorization: "Bearer secret", reason: "mismatch" },
        },
      },
    }), { status: 401, headers: { "content-type": "application/json" } })));
    await expect(requestClientApi("https://license.example.com", "/api/v1/client/validate"))
      .rejects.toMatchObject({
        code: "ACTIVATION_CREDENTIALS_INVALID",
        status: 401,
        requestId: "req_error",
        details: {
          release_version: "2.4.0",
          machine_token: "[REDACTED]",
          nested: JSON.stringify({ authorization: "[REDACTED]", reason: "mismatch" }),
        },
      });
  });

  it("parses the extended activation and deactivation operation responses separately", async () => {
    const responses = [
      { success: true, data: opaqueActivationData() },
      {
        success: true,
        data: {
          activation_id: "act_1",
          status: "deactivated",
          meta: { request_id: "req_deactivate" },
        },
      },
    ];
    let index = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses[index++]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    await expect(apiActivate({
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      licenseKey: "LK-SECRET-VALUE-123",
      fingerprint: "device-fingerprint",
      devicePlatform: "macos-arm64",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
    })).resolves.toMatchObject({
      activation_id: "act_1",
      state: { kind: "license", status: "active" },
      validation: { validated_at: "2026-09-23T10:00:00Z" },
    });
    await expect(apiDeactivate({
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      activationId: "act_1",
      machineToken: "mtk_secret_value_123",
      fingerprint: "device-fingerprint",
    })).resolves.toMatchObject({ status: "deactivated", meta: { request_id: "req_deactivate" } });
  });
});

describe("signed credential verification", () => {
  it("verifies signature, identities and all duplicated response facts before activation storage", async () => {
    const signed = await signedToken();
    const validatedAt = new Date(signed.claims.iat * 1000).toISOString();
    const updatesUntil = new Date(Number(signed.claims.upd) * 1000).toISOString();
    const state: ActiveLicenseState = {
      kind: "license",
      status: "active",
      expires_at: null,
      terms: { max_activations: 1, features: ["export"], updates_until: updatesUntil },
    };
    const response: ActivationResponse = {
      activation_id: "act_1",
      machine_token: "mtk_secret_value_123",
      credential_mode: "signed",
      signed_license_token: signed.token,
      signed_license_token_expires_at: new Date(signed.claims.exp * 1000).toISOString(),
      signing_key_id: "key_v1",
      license_expires_at: null,
      terms: state.terms,
      state,
      validation: validation(validatedAt),
      meta: { request_id: "req_signed" },
    };
    const context = {
      productId: "prd_1",
      activationId: "act_1",
      fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      nowSeconds: signed.claims.iat,
    };
    await expect(verifyActivationResponse(response, { key_v1: signed.publicKey }, context))
      .resolves.toMatchObject({ lic: "lic_1" });

    response.state = {
      ...state,
      terms: { ...state.terms, features: ["tampered"] },
    };
    await expect(verifyActivationResponse(response, { key_v1: signed.publicKey }, context))
      .rejects.toMatchObject({ code: "TOKEN_FEATURES_MISMATCH" });
  });

  it("accepts a valid short-TTL signed update independently of the online validation interval", async () => {
    const signed = await signedToken({ exp: Math.floor(Date.now() / 1000) + 1200 });
    const state: ActiveLicenseState = {
      kind: "license",
      status: "active",
      expires_at: null,
      terms: {
        max_activations: 1,
        features: ["export"],
        updates_until: new Date(Number(signed.claims.upd) * 1000).toISOString(),
      },
    };
    const update: CredentialUpdate = {
      credential_mode: "signed",
      signed_license_token: signed.token,
      signed_license_token_expires_at: new Date(signed.claims.exp * 1000).toISOString(),
      signing_key_id: "key_v1",
    };
    await expect(verifyValidationCredentialUpdate(
      update,
      { key_v1: signed.publicKey },
      {
        productId: "prd_1",
        activationId: "act_1",
        fingerprint: "device-fingerprint",
        releaseVersion: "2.4.0",
        releasePlatform: "macos-universal",
        nowSeconds: signed.claims.iat,
      },
      state
    )).resolves.toMatchObject({ exp: signed.claims.exp });
  });

  it("rejects removed and mismatched signed claims explicitly", async () => {
    const legacy = await signedToken({ ins: "", acc: "acc_1" } as unknown as Partial<SignedLicenseClaims>);
    await expect(verifySignedLicenseToken(legacy.token, legacy.publicKey))
      .rejects.toMatchObject({ code: "TOKEN_CLAIMS_INVALID" });
    const current = await signedToken();
    const verified = await verifySignedLicenseToken(current.token, current.publicKey);
    expect(evaluateSignedLicenseClaims(verified.claims, {
      productId: "prd_other",
      activationId: "act_1",
      fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      nowSeconds: current.claims.iat,
    })).toMatchObject({ valid: false, code: "TOKEN_PRODUCT_MISMATCH" });
  });

  it("keeps License and update entitlement bounds independent from the online window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const beyondLicense = await signedToken({ iat: now - 100, exp: now + 60, lexp: now + 30 });
    await expect(verifySignedLicenseToken(beyondLicense.token, beyondLicense.publicKey))
      .rejects.toMatchObject({ code: "TOKEN_CLAIMS_INVALID" });

    const updateEnded = await signedToken({ rat: 2_000, upd: 1_999, lexp: null });
    const updateClaims = (await verifySignedLicenseToken(updateEnded.token, updateEnded.publicKey)).claims;
    expect(evaluateSignedLicenseClaims(updateClaims, {
      productId: "prd_1",
      activationId: "act_1",
      fingerprint: "device-fingerprint",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      nowSeconds: updateClaims.iat,
    })).toMatchObject({ valid: false, code: "UPDATE_ENTITLEMENT_REQUIRED" });
  });
});

describe("local credential state and periodic verification", () => {
  const configDir = path.join(os.tmpdir(), "licenkit-unified-cli-" + process.pid);

  beforeEach(() => {
    process.env.LICENKIT_CONFIG_DIR = configDir;
    process.exitCode = undefined;
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    delete process.env.LICENKIT_CONFIG_DIR;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function saveOpaqueActive(): void {
    const validatedAt = new Date().toISOString();
    const state = activeState();
    saveStoredLicense({
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      devicePlatform: "macos-arm64",
      activationId: "act_1",
      machineToken: "mtk_secret_value_123",
      credentialMode: "opaque",
      activatedAt: validatedAt,
      lastValidatedAt: validatedAt,
      receivedValidationIntervalSeconds: null,
      effectiveValidationIntervalSeconds: 3600,
      lastEntitlementState: state,
      licenseExpiresAt: null,
      terms: state.terms,
    });
  }

  it("migrates the old local License shape to a default periodic validation window", () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(getLicenseFilePath(), JSON.stringify({
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      devicePlatform: "macos-arm64",
      activationId: "act_1",
      machineToken: "mtk_secret_value_123",
      credentialMode: "opaque",
      activatedAt: "2026-09-23T10:00:00Z",
      lastValidatedAt: "2026-09-23T10:00:00Z",
      licenseExpiresAt: null,
      terms: { max_activations: 1, features: [], updates_until: null },
    }));
    const stored = loadStoredLicense();
    expect(stored).toMatchObject({
      receivedValidationIntervalSeconds: null,
      effectiveValidationIntervalSeconds: 3600,
      lastEntitlementState: { kind: "license", status: "active" },
    });
  });

  it("requires online validate when a valid Signed Token is outside its periodic window", async () => {
    const signed = await signedToken({ exp: Math.floor(Date.now() / 1000) + 7200 });
    const oldValidation = new Date(Date.now() - 3601 * 1000).toISOString();
    saveStoredLicense({
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      devicePlatform: "macos-arm64",
      activationId: "act_1",
      machineToken: "mtk_secret_value_123",
      credentialMode: "signed",
      signedLicenseToken: signed.token,
      signedLicenseTokenExpiresAt: new Date(signed.claims.exp * 1000).toISOString(),
      signingKeyId: "key_v1",
      trustedSigningKeys: { key_v1: signed.publicKey },
      activatedAt: oldValidation,
      lastValidatedAt: oldValidation,
      receivedValidationIntervalSeconds: null,
      effectiveValidationIntervalSeconds: 3600,
      lastEntitlementState: {
        kind: "license",
        status: "active",
        expires_at: null,
        terms: {
          max_activations: 1,
          features: ["export"],
          updates_until: new Date(Number(signed.claims.upd) * 1000).toISOString(),
        },
      },
      licenseExpiresAt: null,
      terms: {
        max_activations: 1,
        features: ["export"],
        updates_until: new Date(Number(signed.claims.upd) * 1000).toISOString(),
      },
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await verifyCommand(undefined, { fingerprint: "device-fingerprint" });
    expect(process.exitCode).toBe(2);
    expect(output.mock.calls.flat().join("\n")).toContain("periodic validation window");
    expect(clearStoredLicense()).toBe(true);
  });

  it("rejects an expired short-TTL token even while the saved online window is fresh", async () => {
    const now = Math.floor(Date.now() / 1000);
    const signed = await signedToken({ iat: now - 120, exp: now - 1 });
    const validatedAt = new Date((now - 100) * 1000).toISOString();
    const terms = {
      max_activations: 1,
      features: ["export"],
      updates_until: new Date(Number(signed.claims.upd) * 1000).toISOString(),
    };
    saveStoredLicense({
      serverUrl: "https://license.example.com",
      productId: "prd_1",
      releaseVersion: "2.4.0",
      releasePlatform: "macos-universal",
      devicePlatform: "macos-arm64",
      activationId: "act_1",
      machineToken: "mtk_secret_value_123",
      credentialMode: "signed",
      signedLicenseToken: signed.token,
      signedLicenseTokenExpiresAt: new Date(signed.claims.exp * 1000).toISOString(),
      signingKeyId: "key_v1",
      trustedSigningKeys: { key_v1: signed.publicKey },
      activatedAt: validatedAt,
      lastValidatedAt: validatedAt,
      receivedValidationIntervalSeconds: null,
      effectiveValidationIntervalSeconds: 3600,
      lastEntitlementState: {
        kind: "license",
        status: "active",
        expires_at: null,
        terms,
      },
      licenseExpiresAt: null,
      terms,
    });
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await verifyCommand(undefined, { fingerprint: "device-fingerprint" });

    expect(process.exitCode).toBe(1);
    expect(output.mock.calls.flat().join("\n")).toContain("TOKEN_EXPIRED");
  });

  it("returns exit 2 and persists Server diagnostics for a confirmed unavailable state", async () => {
    saveOpaqueActive();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        state: {
          kind: "license",
          status: "suspended",
          code: "LICENSE_SUSPENDED",
          reason: "payment_review",
          details: { license_id: "lic_1", machine_token: "must-redact" },
        },
        validation: validation("2026-09-23T11:00:00Z", 1200),
        meta: { request_id: "req_suspended" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await validateCommand();

    expect(process.exitCode).toBe(2);
    expect(loadStoredLicense()).toMatchObject({
      lastValidatedAt: "2026-09-23T11:00:00Z",
      receivedValidationIntervalSeconds: 1200,
      effectiveValidationIntervalSeconds: 3600,
      lastValidationRequestId: "req_suspended",
      lastEntitlementState: {
        status: "suspended",
        code: "LICENSE_SUSPENDED",
        details: { license_id: "lic_1", machine_token: "[REDACTED]" },
      },
    });
    expect(output.mock.calls.flat().join("\n")).toContain("req_suspended");
  });

  it("clears local credentials only after confirmed Activation deactivation diagnostics are printed", async () => {
    saveOpaqueActive();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        state: {
          kind: "license",
          status: "activation_deactivated",
          code: "ACTIVATION_DEACTIVATED",
          details: { activation_id: "act_1" },
        },
        validation: validation("2026-09-23T11:00:00Z"),
        meta: { request_id: "req_deactivated" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await validateCommand();

    expect(process.exitCode).toBe(2);
    expect(loadStoredLicense()).toBeNull();
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("ACTIVATION_DEACTIVATED");
    expect(text).toContain("req_deactivated");
  });
});
