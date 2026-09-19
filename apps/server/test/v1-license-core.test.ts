import { beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { issueManualLicense } from "../src/services/license/issue";
import { activateLicense, validateActivation } from "../src/services/license/activation";
import { rotateLicenseKey } from "../src/services/license/key-rotation";
import { claimTrial, validateTrial } from "../src/services/license/trial";
import { encryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { generateEd25519KeyPair, base64UrlToJson } from "../src/infra/crypto";

describe("V1 License core contract", () => {
  let testEnv: TestEnvContext;
  const accountId = "acc_v1_core";
  const userId = "usr_v1_owner";
  const productId = "prd_v1_app";
  const releaseId = "rel_v1_100";
  const releasedAt = "2026-09-01T00:00:00.000Z";

  async function run(sql: string, ...params: unknown[]) {
    return testEnv.d1.prepare(sql).bind(...params).run();
  }

  async function seedPlan(input: {
    id: string;
    model?: "perpetual" | "fixed_term" | "subscription";
    credential?: "opaque" | "signed";
    defaultTermSeconds?: number | null;
    updateWindowSeconds?: number | null;
    signedTtl?: number;
    paymentGrace?: number;
    maxActivations?: number;
  }) {
    const model = input.model ?? "perpetual";
    const credential = input.credential ?? "opaque";
    await run(
      `INSERT INTO license_plans (
         id, account_id, product_id, name, revision, license_model,
         credential_mode, default_term_seconds, update_window_seconds,
         signed_token_ttl_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '["pro_export"]', 'active', ?12, ?12)`,
      input.id,
      accountId,
      productId,
      `${model} plan`,
      model,
      credential,
      input.defaultTermSeconds ?? null,
      input.updateWindowSeconds ?? null,
      input.signedTtl ?? (credential === "signed" ? 3600 : 0),
      input.paymentGrace ?? 0,
      input.maxActivations ?? 2,
      "2026-09-01T00:00:00.000Z",
    );
  }

  beforeEach(async () => {
    testEnv = createTestEnv();
    await run(
      `INSERT INTO accounts (id, name, slug, default_subscription_payment_grace_seconds, status, created_at, updated_at)
       VALUES (?1, 'V1 Core', 'v1-core', 432000, 'active', ?2, ?2)`,
      accountId,
      "2026-09-01T00:00:00.000Z",
    );
    await run(
      `INSERT INTO users (id, account_id, email, password_hash, name, role, status, created_at, updated_at)
       VALUES (?1, ?2, 'owner@example.com', 'hash', 'Owner', 'owner', 'active', ?3, ?3)`,
      userId,
      accountId,
      "2026-09-01T00:00:00.000Z",
    );
    await run(
      `INSERT INTO products (
         id, account_id, slug, name, description, billing_environment,
         trial_enabled, trial_duration_seconds, trial_features_json, status, created_at, updated_at
       ) VALUES (?1, ?2, 'v1-app', 'V1 App', NULL, NULL, 1, 1200, '["trial_export"]', 'active', ?3, ?3)`,
      productId,
      accountId,
      "2026-09-01T00:00:00.000Z",
    );
    await run(
      `INSERT INTO product_releases (
         id, account_id, product_id, version, platform, description, download_url,
         artifact_sha256, released_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, '1.0.0', 'macos-universal', NULL, NULL, ?4, ?5, ?5, ?5)`,
      releaseId,
      accountId,
      productId,
      "a".repeat(64),
      releasedAt,
    );
  });

  it("freezes perpetual terms and does not inherit later plan edits", async () => {
    await seedPlan({ id: "lpl_perpetual", updateWindowSeconds: 31_536_000, maxActivations: 2 });
    const issuedAt = new Date("2026-09-19T10:00:00.000Z");
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_perpetual",
      customerEmail: "Buyer@Example.COM",
      actor: { type: "user", id: userId },
      now: issuedAt,
    });
    expect(issued.license.licenseModel).toBe("perpetual");
    expect(issued.license.renewalMode).toBe("none");
    expect(issued.license.expiresAt).toBeNull();
    expect(issued.license.updatesUntil).toBe("2027-09-19T10:00:00.000Z");
    expect(issued.delivery.status).toBe("blocked_configuration");

    await run(
      `UPDATE license_plans SET max_activations = 9, features_json = '["changed"]', revision = 2
       WHERE account_id = ?1 AND id = 'lpl_perpetual'`,
      accountId,
    );
    const stored = await testEnv.d1.prepare(
      `SELECT max_activations, features_json, plan_revision, payment_grace_seconds
       FROM licenses WHERE account_id = ?1 AND id = ?2`
    ).bind(accountId, issued.license.id).get();
    expect(stored).toMatchObject({
      max_activations: 2,
      features_json: '["pro_export"]',
      plan_revision: 1,
      payment_grace_seconds: 0,
    });
  });

  it("issues a manual subscription with an explicit term and zero payment grace", async () => {
    await seedPlan({ id: "lpl_manual_sub", model: "subscription", paymentGrace: 432000 });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_manual_sub",
      customerEmail: "manual@example.com",
      expiresAt: "2027-01-01T00:00:00.000Z",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    expect(issued.license.renewalMode).toBe("manual");
    expect(issued.license.paymentGraceSeconds).toBe(0);
    await expect(issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_manual_sub",
      customerEmail: "invalid@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    })).rejects.toMatchObject({ code: "MANUAL_SUBSCRIPTION_EXPIRES_AT_REQUIRED" });
  });

  it("rejects signed License issuance before any side effect when no active signing key exists", async () => {
    await seedPlan({ id: "lpl_signed_without_key", credential: "signed", signedTtl: 3600 });

    await expect(issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_signed_without_key",
      customerEmail: "missing-key@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    })).rejects.toMatchObject({
      code: "SIGNING_KEY_NOT_CONFIGURED",
      details: { product_id: productId },
    });

    const counts = await testEnv.d1.prepare(
      `SELECT
         (SELECT COUNT(*) FROM customers WHERE account_id = ?1) AS customers,
         (SELECT COUNT(*) FROM licenses WHERE account_id = ?1) AS licenses,
         (SELECT COUNT(*) FROM outbound_deliveries WHERE account_id = ?1) AS deliveries,
         (SELECT COUNT(*) FROM audit_logs WHERE account_id = ?1) AS audits`
    ).bind(accountId).get();
    expect(counts).toEqual({ customers: 0, licenses: 0, deliveries: 0, audits: 0 });
  });

  it("activates and validates opaque credentials using only a trusted Product Release", async () => {
    await seedPlan({ id: "lpl_opaque" });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_opaque",
      customerEmail: "opaque@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    const activated = await activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint: "sha256:opaque-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:01:00.000Z"),
    });
    expect(activated.credential_mode).toBe("opaque");
    expect(activated.machine_token).toMatch(/^mtk_[0-9a-f]{64}$/);
    expect(activated.signed_license_token).toBeNull();
    const validated = await validateActivation({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      productId,
      activationId: activated.activation_id,
      machineToken: activated.machine_token,
      fingerprint: "sha256:opaque-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:02:00.000Z"),
    });
    expect(validated.terms.features).toEqual(["pro_export"]);
    await expect(validateActivation({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      productId,
      activationId: activated.activation_id,
      machineToken: activated.machine_token,
      fingerprint: "sha256:opaque-device",
      releaseVersion: "9.9.9",
      releasePlatform: "macos-universal",
    })).rejects.toMatchObject({ code: "PRODUCT_RELEASE_UNKNOWN" });
  });

  it("uses the server Product Release time for update entitlement", async () => {
    await seedPlan({ id: "lpl_updates", updateWindowSeconds: 1 });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_updates",
      customerEmail: "updates@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    await run(
      `INSERT INTO product_releases (
         id, account_id, product_id, version, platform, artifact_sha256,
         released_at, created_at, updated_at
       ) VALUES ('rel_v1_200', ?1, ?2, '2.0.0', 'macos-universal', ?3, ?4, ?4, ?4)`,
      accountId,
      productId,
      "b".repeat(64),
      "2026-10-01T00:00:00.000Z",
    );
    await expect(activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint: "sha256:new-release-device",
      releaseVersion: "2.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:00:00.500Z"),
    })).rejects.toMatchObject({
      code: "UPDATE_ENTITLEMENT_REQUIRED",
      details: { released_at: "2026-10-01T00:00:00.000Z" },
    });
  });

  it("enforces the activation limit in the database under concurrent requests", async () => {
    await seedPlan({ id: "lpl_one_seat", maxActivations: 1 });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_one_seat",
      customerEmail: "one-seat@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    const attempts = await Promise.allSettled(["device-a", "device-b"].map((device) =>
      activateLicense({
        db: testEnv.d1,
        env: testEnv.env,
        accountId,
        productId,
        licenseKey: issued.license.licenseKey,
        fingerprint: `sha256:${device}`,
        releaseVersion: "1.0.0",
        releasePlatform: "macos-universal",
      })
    ));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "LICENSE_ACTIVATION_LIMIT_REACHED" });
    const count = await testEnv.d1.prepare(
      `SELECT COUNT(*) AS count FROM activations WHERE account_id = ?1 AND status = 'active'`
    ).bind(accountId).get();
    expect(count.count).toBe(1);
  });

  it("returns a strict EdDSA signed token bound to the trusted release", async () => {
    const keyId = "key_v1_active";
    const keyPair = await generateEd25519KeyPair();
    const encrypted = await encryptEnvelopeV1(keyPair.privateKeyPkcs8Base64, testEnv.env, {
      accountId,
      table: "signing_keys",
      rowId: keyId,
      field: "private_key_ciphertext",
    });
    await run(
      `INSERT INTO signing_keys (
         id, account_id, product_id, algorithm, source, public_key,
         private_key_ciphertext, status, created_at, retired_at, revoked_at
       ) VALUES (?1, ?2, ?3, 'Ed25519', 'generated', ?4, ?5, 'active', ?6, NULL, NULL)`,
      keyId,
      accountId,
      productId,
      keyPair.publicKeyBase64,
      encrypted,
      "2026-09-01T00:00:00.000Z",
    );
    await seedPlan({ id: "lpl_signed", credential: "signed", signedTtl: 3600 });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_signed",
      customerEmail: "signed@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    const activated = await activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint: "sha256:signed-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:01:00.000Z"),
    });
    const [headerPart, claimsPart] = activated.signed_license_token!.split(".");
    expect(base64UrlToJson(headerPart)).toEqual({
      alg: "EdDSA",
      typ: "licenkit-license+jwt",
      kid: keyId,
    });
    expect(base64UrlToJson<any>(claimsPart)).toMatchObject({
      lic: issued.license.id,
      act: activated.activation_id,
      acc: accountId,
      prd: productId,
      rel: releaseId,
      ver: "1.0.0",
      plt: "macos-universal",
      rat: Date.parse(releasedAt) / 1000,
    });
  });

  it("does not create a seat or replace a machine token when signed token preparation fails", async () => {
    const keyId = "key_v1_failure_atomicity";
    const keyPair = await generateEd25519KeyPair();
    const encrypted = await encryptEnvelopeV1(keyPair.privateKeyPkcs8Base64, testEnv.env, {
      accountId,
      table: "signing_keys",
      rowId: keyId,
      field: "private_key_ciphertext",
    });
    await run(
      `INSERT INTO signing_keys (
         id, account_id, product_id, algorithm, source, public_key,
         private_key_ciphertext, status, created_at, retired_at, revoked_at
       ) VALUES (?1, ?2, ?3, 'Ed25519', 'generated', ?4, ?5, 'active', ?6, NULL, NULL)`,
      keyId,
      accountId,
      productId,
      keyPair.publicKeyBase64,
      encrypted,
      "2026-09-01T00:00:00.000Z",
    );
    await seedPlan({ id: "lpl_signed_atomic", credential: "signed", signedTtl: 3600 });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_signed_atomic",
      customerEmail: "signed-atomic@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });

    await run(
      `UPDATE signing_keys SET private_key_ciphertext = 'not-an-envelope' WHERE account_id = ?1 AND id = ?2`,
      accountId,
      keyId,
    );
    const activationInput = {
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint: "sha256:signed-atomic-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:01:00.000Z"),
    };
    await expect(activateLicense(activationInput)).rejects.toThrow("DELIVERY_ENVELOPE_INVALID_JSON");
    const empty = await testEnv.d1.prepare(
      `SELECT COUNT(*) AS count FROM activations WHERE account_id = ?1 AND license_id = ?2`
    ).bind(accountId, issued.license.id).get();
    expect(empty.count).toBe(0);

    await run(
      `UPDATE signing_keys SET private_key_ciphertext = ?1 WHERE account_id = ?2 AND id = ?3`,
      encrypted,
      accountId,
      keyId,
    );
    const activated = await activateLicense(activationInput);
    const beforeFailure = await testEnv.d1.prepare(
      `SELECT machine_token_hash, updated_at FROM activations
       WHERE account_id = ?1 AND license_id = ?2 AND id = ?3`
    ).bind(accountId, issued.license.id, activated.activation_id).get();

    await run(
      `UPDATE signing_keys SET private_key_ciphertext = 'not-an-envelope' WHERE account_id = ?1 AND id = ?2`,
      accountId,
      keyId,
    );
    await expect(activateLicense({
      ...activationInput,
      now: new Date("2026-09-19T10:02:00.000Z"),
    })).rejects.toThrow("DELIVERY_ENVELOPE_INVALID_JSON");
    const afterFailure = await testEnv.d1.prepare(
      `SELECT machine_token_hash, updated_at FROM activations
       WHERE account_id = ?1 AND license_id = ?2 AND id = ?3`
    ).bind(accountId, issued.license.id, activated.activation_id).get();
    expect(afterFailure).toEqual(beforeFailure);
  });

  it("keeps activations on recovery and revokes them on security reset", async () => {
    await seedPlan({ id: "lpl_rotate" });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licensePlanId: "lpl_rotate",
      customerEmail: "rotate@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    const activated = await activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint: "sha256:rotate-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    });
    const recovered = await rotateLicenseKey({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licenseId: issued.license.id,
      actor: { type: "user", id: userId },
      reason: "recovery",
    });
    expect(recovered.license.keyVersion).toBe(2);
    await expect(validateActivation({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      productId,
      activationId: activated.activation_id,
      machineToken: activated.machine_token,
      fingerprint: "sha256:rotate-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    })).resolves.toBeDefined();
    await rotateLicenseKey({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      licenseId: issued.license.id,
      actor: { type: "user", id: userId },
      reason: "security_reset",
    });
    await expect(validateActivation({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      productId,
      activationId: activated.activation_id,
      machineToken: activated.machine_token,
      fingerprint: "sha256:rotate-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    })).rejects.toMatchObject({ code: "ACTIVATION_REVOKED" });
  });

  it("allows one online-only Trial Claim per product and device", async () => {
    const first = await claimTrial({
      db: testEnv.d1,
      accountId,
      productId,
      fingerprint: "sha256:trial-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    expect(first.trial_token).toMatch(/^ttk_[0-9a-f]{64}$/);
    await expect(claimTrial({
      db: testEnv.d1,
      accountId,
      productId,
      fingerprint: "sha256:trial-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    })).rejects.toMatchObject({ code: "TRIAL_ALREADY_CLAIMED" });
    const validated = await validateTrial({
      db: testEnv.d1,
      accountId,
      productId,
      trialId: first.trial_id,
      trialToken: first.trial_token,
      fingerprint: "sha256:trial-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:10:00.000Z"),
    });
    expect(validated.features).toEqual(["trial_export"]);
    await run(
      `UPDATE trial_claims SET revoked_at = ?1, revoke_reason = 'abuse', updated_at = ?1
       WHERE account_id = ?2 AND product_id = ?3 AND id = ?4`,
      "2026-09-19T10:11:00.000Z",
      accountId,
      productId,
      first.trial_id,
    );
    await expect(validateTrial({
      db: testEnv.d1,
      accountId,
      productId,
      trialId: first.trial_id,
      trialToken: first.trial_token,
      fingerprint: "sha256:trial-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    })).rejects.toMatchObject({ code: "TRIAL_REVOKED" });
  });
});
