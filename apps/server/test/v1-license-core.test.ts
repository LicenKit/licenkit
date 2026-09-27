import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/types";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { issueManualLicense } from "../src/services/license/issue";
import { activateLicense, validateActivation } from "../src/services/license/activation";
import { rotateLicenseKey } from "../src/services/license/key-rotation";
import { claimTrial, validateTrial } from "../src/services/license/trial";
import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { generateEd25519KeyPair, base64UrlToJson } from "../src/infra/crypto";
import { clientRouter } from "../src/routes/client.routes";
import { adminLicensePlansRouter } from "../src/routes/admin/license-plans.routes";
import { errorHandler } from "../src/middleware/error";
import { requestContext } from "../src/middleware/request-context";

function clientApp() {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", requestContext);
  app.route("/api/v1/client", clientRouter);
  return app;
}

function adminLicensePlansApp() {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_plan_test");
    c.set("instanceId", "ins_v1_core");
    c.set("instanceRole", "owner");
    c.set("userId", "usr_v1_owner");
    c.set("userEmail", "owner@example.com");
    await next();
  });
  app.route("/", adminLicensePlansRouter);
  return app;
}

describe("V1 License core contract", () => {
  let testEnv: TestEnvContext;
  const instanceId = "ins_v1_core";
  const userId = "usr_v1_owner";
  const productId = "prd_00000000000000000000000001";
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
         id, instance_id, product_id, name, revision, license_model,
         credential_mode, default_term_seconds, update_window_seconds,
         signed_token_ttl_seconds, payment_grace_seconds, max_activations,
         features_json, status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '["pro_export"]', 'active', ?12, ?12)`,
      input.id,
      instanceId,
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
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES (?1, 'V1 Core', 'https://license.example.test', 'https://admin.example.test', 'active', ?2, ?2)`,
      instanceId,
      "2026-09-01T00:00:00.000Z",
    );
    await run(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES (?1, 'owner@example.com', 'hash', 'Owner', ?2, ?2)`,
      userId,
      "2026-09-01T00:00:00.000Z",
    );
    await run(
      `INSERT INTO instance_memberships (instance_id, user_id, role, status, created_at, updated_at)
       VALUES (?1, ?2, 'owner', 'active', ?3, ?3)`,
      instanceId,
      userId,
      "2026-09-01T00:00:00.000Z",
    );
    await run(
      `INSERT INTO products (
         id, instance_id, name, description, billing_environment,
         payment_grace_seconds, trial_enabled, trial_duration_seconds,
         trial_features_json, status, created_at, updated_at
       ) VALUES (?1, ?2, 'V1 App', NULL, NULL, 432000, 1, 1200,
                 '["trial_export"]', 'active', ?3, ?3)`,
      productId,
      instanceId,
      "2026-09-01T00:00:00.000Z",
    );
    await run(
      `INSERT INTO product_releases (
         id, instance_id, product_id, version, platform, description, download_url,
         artifact_sha256, released_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, '1.0.0', 'macos-universal', NULL, NULL, ?4, ?5, ?5, ?5)`,
      releaseId,
      instanceId,
      productId,
      "a".repeat(64),
      releasedAt,
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("snapshots the Product payment grace when creating a subscription Plan", async () => {
    const legacy = await adminLicensePlansApp().request("https://license.example.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId,
        name: "Legacy subscription",
        licenseModel: "subscription",
        credentialMode: "opaque",
        signedTokenTtlSeconds: 0,
        maxActivations: 2,
        features: [],
      }),
    }, testEnv.env);
    expect(legacy.status).toBe(400);
    expect((await legacy.json() as any).error.code).toBe("VALIDATION_ERROR");

    const response = await adminLicensePlansApp().request("https://license.example.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: productId,
        name: "Subscription",
        license_model: "subscription",
        credential_mode: "opaque",
        signed_token_ttl_seconds: 0,
        max_activations: 2,
        features: [],
      }),
    }, testEnv.env);
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.data.instance_id).toBe(instanceId);
    expect(body.data).not.toHaveProperty("instanceId");
    expect(body.data.payment_grace_seconds).toBe(432000);
    expect(body.data).not.toHaveProperty("paymentGraceSeconds");
    expect(testEnv.sqliteDb.prepare(
      "SELECT payment_grace_seconds FROM license_plans WHERE instance_id = ? AND product_id = ?",
    ).get(instanceId, productId)).toEqual({ payment_grace_seconds: 432000 });
  });

  it("freezes perpetual terms and does not inherit later plan edits", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    await seedPlan({ id: "lpl_perpetual", updateWindowSeconds: 31_536_000, maxActivations: 2 });
    const issuedAt = new Date("2026-09-19T10:00:00.000Z");
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licensePlanId: "lpl_perpetual",
      customerEmail: "Buyer@Example.COM",
      actor: { type: "user", id: userId },
      now: issuedAt,
    });
    expect(issued.license.licenseModel).toBe("perpetual");
    expect(issued.license.renewalMode).toBe("none");
    expect(issued.license.expiresAt).toBeNull();
    expect(issued.license.updatesUntil).toBe("2027-09-19T10:00:00.000Z");
    expect(issued.delivery.status).toBe("waiting_configuration");
    expect(providerFetch).not.toHaveBeenCalled();

    const delivery = testEnv.sqliteDb.prepare(
      `SELECT notification_type, contract_version, recipient_email, status,
              attempt_count, variables_ciphertext
       FROM email_deliveries WHERE instance_id = ? AND id = ?`,
    ).get(instanceId, issued.delivery.id) as any;
    expect(delivery).toMatchObject({
      notification_type: "customer.license_issued",
      contract_version: 1,
      recipient_email: "buyer@example.com",
      status: "waiting_configuration",
      attempt_count: 0,
    });
    const variables = JSON.parse(await decryptEnvelopeV1(
      delivery.variables_ciphertext,
      testEnv.env,
      {
        instanceId,
        table: "email_deliveries",
        rowId: issued.delivery.id,
        field: "variables_ciphertext",
      },
    ));
    expect(variables).toMatchObject({
      instance_name: "V1 Core",
      product_id: productId,
      product_name: "V1 App",
      license_id: issued.license.id,
      license_key: issued.license.licenseKey,
      license_model: "perpetual",
      updates_until: "2027-09-19T10:00:00.000Z",
    });
    expect(variables).not.toHaveProperty("recipient_email");
    expect(variables).not.toHaveProperty("expires_at");

    await run(
      `UPDATE license_plans SET max_activations = 9, features_json = '["changed"]', revision = 2
       WHERE instance_id = ?1 AND id = 'lpl_perpetual'`,
      instanceId,
    );
    const stored = await testEnv.d1.prepare(
      `SELECT max_activations, features_json, plan_revision, payment_grace_seconds
       FROM licenses WHERE instance_id = ?1 AND id = ?2`
    ).bind(instanceId, issued.license.id).get();
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
      instanceId,
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
      instanceId,
      licensePlanId: "lpl_manual_sub",
      customerEmail: "invalid@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    })).rejects.toMatchObject({ code: "MANUAL_SUBSCRIPTION_EXPIRES_AT_REQUIRED" });
  });

  it("rolls back manual issuance when the selected Plan changes before commit", async () => {
    await seedPlan({ id: "lpl_racing_manual" });
    const racingDb = {
      ...testEnv.d1,
      batch: async (statements: D1PreparedStatement[]) => {
        testEnv.sqliteDb.prepare(
          "UPDATE license_plans SET status = 'archived' WHERE instance_id = ? AND id = ?",
        ).run(instanceId, "lpl_racing_manual");
        return testEnv.d1.batch(statements);
      },
    } as D1Database;

    await expect(issueManualLicense({
      db: racingDb,
      env: testEnv.env,
      instanceId,
      licensePlanId: "lpl_racing_manual",
      customerEmail: "racing@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    })).rejects.toMatchObject({ code: "LICENSE_MANUAL_ISSUE_STATE_CHANGED" });

    expect(testEnv.sqliteDb.prepare(
      `SELECT
         (SELECT COUNT(*) FROM customers WHERE instance_id = ?) AS customers,
         (SELECT COUNT(*) FROM licenses WHERE instance_id = ?) AS licenses,
         (SELECT COUNT(*) FROM email_deliveries WHERE instance_id = ?) AS deliveries,
         (SELECT COUNT(*) FROM audit_logs WHERE instance_id = ?) AS audits`,
    ).get(instanceId, instanceId, instanceId, instanceId)).toEqual({
      customers: 0,
      licenses: 0,
      deliveries: 0,
      audits: 0,
    });
  });

  it("rejects signed License issuance before any side effect when no active signing key exists", async () => {
    await seedPlan({ id: "lpl_signed_without_key", credential: "signed", signedTtl: 3600 });

    await expect(issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
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
         (SELECT COUNT(*) FROM customers WHERE instance_id = ?1) AS customers,
         (SELECT COUNT(*) FROM licenses WHERE instance_id = ?1) AS licenses,
         (SELECT COUNT(*) FROM email_deliveries WHERE instance_id = ?1) AS deliveries,
         (SELECT COUNT(*) FROM audit_logs WHERE instance_id = ?1) AS audits`
    ).bind(instanceId).get();
    expect(counts).toEqual({ customers: 0, licenses: 0, deliveries: 0, audits: 0 });
  });

  it("activates and validates opaque credentials using only a trusted Product Release", async () => {
    await seedPlan({ id: "lpl_opaque" });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licensePlanId: "lpl_opaque",
      customerEmail: "opaque@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    const activated = await activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
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
      instanceId,
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
      instanceId,
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
      instanceId,
      licensePlanId: "lpl_updates",
      customerEmail: "updates@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    await run(
      `INSERT INTO product_releases (
         id, instance_id, product_id, version, platform, artifact_sha256,
         released_at, created_at, updated_at
       ) VALUES ('rel_v1_200', ?1, ?2, '2.0.0', 'macos-universal', ?3, ?4, ?4, ?4)`,
      instanceId,
      productId,
      "b".repeat(64),
      "2026-10-01T00:00:00.000Z",
    );
    await expect(activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
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
      instanceId,
      licensePlanId: "lpl_one_seat",
      customerEmail: "one-seat@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    const attempts = await Promise.allSettled(["device-a", "device-b"].map((device) =>
      activateLicense({
        db: testEnv.d1,
        env: testEnv.env,
        instanceId,
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
      `SELECT COUNT(*) AS count FROM activations WHERE instance_id = ?1 AND status = 'active'`
    ).bind(instanceId).get();
    expect(count.count).toBe(1);
  });

  it("returns a strict EdDSA signed token bound to the trusted release", async () => {
    const keyId = "key_v1_active";
    const keyPair = await generateEd25519KeyPair();
    const encrypted = await encryptEnvelopeV1(keyPair.privateKeyPkcs8Base64, testEnv.env, {
      instanceId,
      table: "signing_keys",
      rowId: keyId,
      field: "private_key_ciphertext",
    });
    await run(
      `INSERT INTO signing_keys (
         id, instance_id, product_id, algorithm, source, public_key,
         private_key_ciphertext, status, created_at, retired_at, revoked_at
       ) VALUES (?1, ?2, ?3, 'Ed25519', 'generated', ?4, ?5, 'active', ?6, NULL, NULL)`,
      keyId,
      instanceId,
      productId,
      keyPair.publicKeyBase64,
      encrypted,
      "2026-09-01T00:00:00.000Z",
    );
    await seedPlan({ id: "lpl_signed", credential: "signed", signedTtl: 3600 });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licensePlanId: "lpl_signed",
      customerEmail: "signed@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    const activated = await activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
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
      ins: instanceId,
      prd: productId,
      rel: releaseId,
      ver: "1.0.0",
      plt: "macos-universal",
      rat: Date.parse(releasedAt) / 1000,
    });
    expect(base64UrlToJson<any>(claimsPart)).not.toHaveProperty("acc");
  });

  it("resolves Product signing keys from the globally unique Product ID", async () => {
    const keyId = "key_v1_public";
    const keyPair = await generateEd25519KeyPair();
    const encrypted = await encryptEnvelopeV1(keyPair.privateKeyPkcs8Base64, testEnv.env, {
      instanceId,
      table: "signing_keys",
      rowId: keyId,
      field: "private_key_ciphertext",
    });
    await run(
      `INSERT INTO signing_keys (
         id, instance_id, product_id, algorithm, source, public_key,
         private_key_ciphertext, status, created_at, retired_at, revoked_at
       ) VALUES (?1, ?2, ?3, 'Ed25519', 'generated', ?4, ?5, 'active', ?6, NULL, NULL)`,
      keyId,
      instanceId,
      productId,
      keyPair.publicKeyBase64,
      encrypted,
      "2026-09-01T00:00:00.000Z",
    );
    const app = clientApp();
    const selected = await app.request(
      `https://license.example.test/api/v1/client/products/${productId}/signing-keys`,
      {},
      testEnv.env,
    );
    expect(selected.status).toBe(200);
    expect((await selected.json() as any).data.items).toEqual([
      expect.objectContaining({ id: keyId, public_key: keyPair.publicKeyBase64, status: "active" }),
    ]);
    expect((await (await app.request(
      `https://license.example.test/api/v1/client/products/${productId}/signing-keys?instance_id=${instanceId}`,
      {},
      testEnv.env,
    )).json() as any).error.code).toBe("VALIDATION_ERROR");
  });

  it("does not create a seat or replace a machine token when signed token preparation fails", async () => {
    const keyId = "key_v1_failure_atomicity";
    const keyPair = await generateEd25519KeyPair();
    const encrypted = await encryptEnvelopeV1(keyPair.privateKeyPkcs8Base64, testEnv.env, {
      instanceId,
      table: "signing_keys",
      rowId: keyId,
      field: "private_key_ciphertext",
    });
    await run(
      `INSERT INTO signing_keys (
         id, instance_id, product_id, algorithm, source, public_key,
         private_key_ciphertext, status, created_at, retired_at, revoked_at
       ) VALUES (?1, ?2, ?3, 'Ed25519', 'generated', ?4, ?5, 'active', ?6, NULL, NULL)`,
      keyId,
      instanceId,
      productId,
      keyPair.publicKeyBase64,
      encrypted,
      "2026-09-01T00:00:00.000Z",
    );
    await seedPlan({ id: "lpl_signed_atomic", credential: "signed", signedTtl: 3600 });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licensePlanId: "lpl_signed_atomic",
      customerEmail: "signed-atomic@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });

    await run(
      `UPDATE signing_keys SET private_key_ciphertext = 'not-an-envelope' WHERE instance_id = ?1 AND id = ?2`,
      instanceId,
      keyId,
    );
    const activationInput = {
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint: "sha256:signed-atomic-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:01:00.000Z"),
    };
    await expect(activateLicense(activationInput)).rejects.toThrow("DELIVERY_ENVELOPE_INVALID_JSON");
    const empty = await testEnv.d1.prepare(
      `SELECT COUNT(*) AS count FROM activations WHERE instance_id = ?1 AND license_id = ?2`
    ).bind(instanceId, issued.license.id).get();
    expect(empty.count).toBe(0);

    await run(
      `UPDATE signing_keys SET private_key_ciphertext = ?1 WHERE instance_id = ?2 AND id = ?3`,
      encrypted,
      instanceId,
      keyId,
    );
    const activated = await activateLicense(activationInput);
    const beforeFailure = await testEnv.d1.prepare(
      `SELECT machine_token_hash, updated_at FROM activations
       WHERE instance_id = ?1 AND license_id = ?2 AND id = ?3`
    ).bind(instanceId, issued.license.id, activated.activation_id).get();

    await run(
      `UPDATE signing_keys SET private_key_ciphertext = 'not-an-envelope' WHERE instance_id = ?1 AND id = ?2`,
      instanceId,
      keyId,
    );
    await expect(activateLicense({
      ...activationInput,
      now: new Date("2026-09-19T10:02:00.000Z"),
    })).rejects.toThrow("DELIVERY_ENVELOPE_INVALID_JSON");
    const afterFailure = await testEnv.d1.prepare(
      `SELECT machine_token_hash, updated_at FROM activations
       WHERE instance_id = ?1 AND license_id = ?2 AND id = ?3`
    ).bind(instanceId, issued.license.id, activated.activation_id).get();
    expect(afterFailure).toEqual(beforeFailure);
  });

  it("keeps activations on recovery and revokes them on security reset", async () => {
    await seedPlan({ id: "lpl_rotate" });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licensePlanId: "lpl_rotate",
      customerEmail: "rotate@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    const activated = await activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint: "sha256:rotate-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    });
    const recovered = await rotateLicenseKey({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licenseId: issued.license.id,
      actor: { type: "user", id: userId },
      reason: "recovery",
    });
    expect(recovered.license.keyVersion).toBe(2);
    await expect(validateActivation({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      productId,
      activationId: activated.activation_id,
      machineToken: activated.machine_token,
      fingerprint: "sha256:rotate-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    })).resolves.toBeDefined();
    const reset = await rotateLicenseKey({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licenseId: issued.license.id,
      actor: { type: "user", id: userId },
      reason: "security_reset",
    });
    await expect(validateActivation({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      productId,
      activationId: activated.activation_id,
      machineToken: activated.machine_token,
      fingerprint: "sha256:rotate-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    })).rejects.toMatchObject({ code: "ACTIVATION_REVOKED" });

    const rows = testEnv.sqliteDb.prepare(
      `SELECT id, notification_type, status, variables_ciphertext
       FROM email_deliveries
       WHERE instance_id = ? AND customer_id = ?
       ORDER BY CASE notification_type
         WHEN 'customer.license_issued' THEN 1
         WHEN 'customer.license_recovered' THEN 2
         WHEN 'customer.license_security_reset' THEN 3
         ELSE 4 END`,
    ).all(instanceId, issued.license.customerId) as any[];
    expect(rows.map((row) => row.notification_type)).toEqual([
      "customer.license_issued",
      "customer.license_recovered",
      "customer.license_security_reset",
    ]);
    for (const [row, expected] of [
      [rows[1], { type: "customer.license_recovered", version: 2, key: recovered.licenseKey }],
      [rows[2], { type: "customer.license_security_reset", version: 3, key: reset.licenseKey }],
    ] as const) {
      expect(row.status).toBe("waiting_configuration");
      const variables = JSON.parse(await decryptEnvelopeV1(
        row.variables_ciphertext,
        testEnv.env,
        {
          instanceId,
          table: "email_deliveries",
          rowId: row.id,
          field: "variables_ciphertext",
        },
      ));
      expect(row.notification_type).toBe(expected.type);
      expect(variables).toMatchObject({
        product_id: productId,
        product_name: "V1 App",
        license_id: issued.license.id,
        license_key: expected.key,
        license_model: "perpetual",
        key_version: expected.version,
      });
      expect(variables).not.toHaveProperty("expires_at");
      expect(variables).not.toHaveProperty("updates_until");
    }
  });

  it("allows one online-only Trial Claim per product and device", async () => {
    const first = await claimTrial({
      db: testEnv.d1,
      instanceId,
      productId,
      fingerprint: "sha256:trial-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    expect(first.trial_token).toMatch(/^ttk_[0-9a-f]{64}$/);
    await expect(claimTrial({
      db: testEnv.d1,
      instanceId,
      productId,
      fingerprint: "sha256:trial-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    })).rejects.toMatchObject({ code: "TRIAL_ALREADY_CLAIMED" });
    const validated = await validateTrial({
      db: testEnv.d1,
      instanceId,
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
       WHERE instance_id = ?2 AND product_id = ?3 AND id = ?4`,
      "2026-09-19T10:11:00.000Z",
      instanceId,
      productId,
      first.trial_id,
    );
    await expect(validateTrial({
      db: testEnv.d1,
      instanceId,
      productId,
      trialId: first.trial_id,
      trialToken: first.trial_token,
      fingerprint: "sha256:trial-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    })).rejects.toMatchObject({ code: "TRIAL_REVOKED" });
  });

  it("uses one strict Client Validate request for no-credential Trial availability", async () => {
    const app = clientApp();
    const requestBody = {
      product_id: productId,
      fingerprint: "sha256:none-device",
      release_version: "1.0.0",
      release_platform: "macos-universal",
      credential: { kind: "none" },
    };
    const available = await app.request("https://license.example.test/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "req_none_available" },
      body: JSON.stringify(requestBody),
    }, testEnv.env);
    expect(available.status).toBe(200);
    expect(await available.json()).toEqual({
      success: true,
      data: {
        state: {
          kind: "activation_required",
          trial: { status: "available", duration_seconds: 1200, features: ["trial_export"] },
        },
        validation: {
          validation_interval_seconds: null,
          validated_at: expect.any(String),
        },
        meta: { request_id: "req_none_available" },
      },
    });

    const unknownRelease = await app.request("https://license.example.test/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...requestBody, release_version: "9.9.9" }),
    }, testEnv.env);
    expect(unknownRelease.status).toBe(200);
    expect((await unknownRelease.json() as any).data.state).toEqual({
      kind: "release_not_eligible",
      status: "unknown_release",
      code: "PRODUCT_RELEASE_UNKNOWN",
      release_version: "9.9.9",
      release_platform: "macos-universal",
      details: {
        release_version: "9.9.9",
        release_platform: "macos-universal",
      },
    });

    const mixedCredential = await app.request("https://license.example.test/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody,
        credential: { kind: "none", machine_token: "mtk_not_allowed_here" },
      }),
    }, testEnv.env);
    expect(mixedCredential.status).toBe(400);
    expect((await mixedCredential.json() as any).error.code).toBe("VALIDATION_ERROR");

    const legacyRequest = await app.request("https://license.example.test/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: productId,
        fingerprint: "sha256:none-device",
        release_version: "1.0.0",
        release_platform: "macos-universal",
        activation_id: "act_legacy",
        machine_token: "mtk_legacy_request_token",
      }),
    }, testEnv.env);
    expect(legacyRequest.status).toBe(400);

    const legacyInstance = await app.request("https://license.example.test/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...requestBody, instance_id: instanceId }),
    }, testEnv.env);
    expect(legacyInstance.status).toBe(400);

    await run(
      "UPDATE products SET trial_enabled = 0, trial_duration_seconds = NULL WHERE instance_id = ?1 AND id = ?2",
      instanceId,
      productId,
    );
    const disabled = await app.request("https://license.example.test/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }, testEnv.env);
    expect((await disabled.json() as any).data.state).toEqual({
      kind: "activation_required",
      trial: { status: "unavailable", reason: "not_enabled", code: "TRIAL_NOT_ENABLED" },
    });

    await run(
      "UPDATE products SET status = 'archived' WHERE instance_id = ?1 AND id = ?2",
      instanceId,
      productId,
    );
    const archived = await app.request("https://license.example.test/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }, testEnv.env);
    expect(archived.status).toBe(409);
    expect((await archived.json() as any).error.code).toBe("PRODUCT_UNAVAILABLE");
  });

  it("does not disclose prior Trial Claim identity without its credential", async () => {
    const fingerprint = "sha256:claimed-device";
    await claimTrial({
      db: testEnv.d1,
      instanceId,
      productId,
      fingerprint,
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    });
    const app = clientApp();
    const unavailable = await app.request("https://license.example.test/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: productId,
        fingerprint,
        release_version: "1.0.0",
        release_platform: "macos-universal",
        credential: { kind: "none" },
      }),
    }, testEnv.env);
    const unavailableBody = await unavailable.json() as any;
    expect(unavailable.status).toBe(200);
    expect(unavailableBody.data.state).toEqual({
      kind: "activation_required",
      trial: {
        status: "unavailable",
        reason: "already_claimed",
        code: "TRIAL_ALREADY_CLAIMED",
      },
    });
    expect(JSON.stringify(unavailableBody)).not.toContain("trl_");

    const duplicate = await app.request("https://license.example.test/api/v1/client/trials/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: productId,
        fingerprint,
        release_version: "1.0.0",
        release_platform: "macos-universal",
      }),
    }, testEnv.env);
    const duplicateBody = await duplicate.json() as any;
    expect(duplicate.status).toBe(409);
    expect(duplicateBody.error.code).toBe("TRIAL_ALREADY_CLAIMED");
    expect(duplicateBody.error).not.toHaveProperty("details");
    expect(JSON.stringify(duplicateBody)).not.toContain("trl_");

    const removedRoute = await app.request("https://license.example.test/api/v1/client/trials/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, testEnv.env);
    expect(removedRoute.status).toBe(404);
  });

  it("returns Server snapshot metadata from explicit Client operations", async () => {
    await seedPlan({ id: "lpl_operation_metadata" });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licensePlanId: "lpl_operation_metadata",
      customerEmail: "operations@example.com",
      actor: { type: "user", id: userId },
      now: new Date(),
    });
    const app = clientApp();
    const activatedResponse = await app.request("https://license.example.test/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "req_activate_snapshot" },
      body: JSON.stringify({
        product_id: productId,
        license_key: issued.license.licenseKey,
        fingerprint: "sha256:operation-license-device",
        release_version: "1.0.0",
        release_platform: "macos-universal",
      }),
    }, testEnv.env);
    const activatedBody = await activatedResponse.json() as any;
    expect(activatedResponse.status).toBe(200);
    expect(activatedBody.data).toMatchObject({
      state: { kind: "license", status: "active" },
      validation: { validation_interval_seconds: null, validated_at: expect.any(String) },
      meta: { request_id: "req_activate_snapshot" },
    });
    expect(activatedBody.data).not.toHaveProperty("next_validation_at");
    expect(testEnv.sqliteDb.prepare(
      "SELECT last_validated_at FROM activations WHERE instance_id = ? AND id = ?",
    ).get(instanceId, activatedBody.data.activation_id)).toEqual({
      last_validated_at: activatedBody.data.validation.validated_at,
    });

    const claimedResponse = await app.request("https://license.example.test/api/v1/client/trials/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "req_trial_snapshot" },
      body: JSON.stringify({
        product_id: productId,
        fingerprint: "sha256:operation-trial-device",
        release_version: "1.0.0",
        release_platform: "macos-universal",
      }),
    }, testEnv.env);
    const claimedBody = await claimedResponse.json() as any;
    expect(claimedResponse.status).toBe(201);
    expect(claimedBody.data).toMatchObject({
      state: { kind: "trial", status: "active" },
      validation: { validation_interval_seconds: null, validated_at: expect.any(String) },
      meta: { request_id: "req_trial_snapshot" },
    });
    expect(testEnv.sqliteDb.prepare(
      "SELECT last_validated_at FROM trial_claims WHERE instance_id = ? AND id = ?",
    ).get(instanceId, claimedBody.data.trial_id)).toEqual({
      last_validated_at: claimedBody.data.validation.validated_at,
    });

    const deactivatedResponse = await app.request("https://license.example.test/api/v1/client/deactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "req_deactivate" },
      body: JSON.stringify({
        product_id: productId,
        activation_id: activatedBody.data.activation_id,
        machine_token: activatedBody.data.machine_token,
        fingerprint: "sha256:operation-license-device",
      }),
    }, testEnv.env);
    const deactivatedBody = await deactivatedResponse.json() as any;
    expect(deactivatedResponse.status).toBe(200);
    expect(deactivatedBody.data.meta).toEqual({ request_id: "req_deactivate" });
    expect(deactivatedBody.data).not.toHaveProperty("state");
    expect(deactivatedBody.data).not.toHaveProperty("validation");
  });

  it("returns authenticated Trial terminal facts as successful validation states", async () => {
    const fingerprint = "sha256:trial-state-device";
    const claimed = await claimTrial({
      db: testEnv.d1,
      instanceId,
      productId,
      fingerprint,
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    });
    const app = clientApp();
    const validate = (trialToken: string) => app.request(
      "https://license.example.test/api/v1/client/validate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: productId,
          fingerprint,
          release_version: "1.0.0",
          release_platform: "macos-universal",
          credential: { kind: "trial", trial_id: claimed.trial_id, trial_token: trialToken },
        }),
      },
      testEnv.env,
    );

    const active = await validate(claimed.trial_token);
    expect((await active.json() as any).data.state).toMatchObject({
      kind: "trial",
      status: "active",
      features: ["trial_export"],
    });

    await run(
      `UPDATE trial_claims
       SET claimed_at = '2019-12-31T00:00:00.000Z',
           expires_at = '2020-01-01T00:00:00.000Z', updated_at = ?1
       WHERE instance_id = ?2 AND product_id = ?3 AND id = ?4`,
      new Date().toISOString(),
      instanceId,
      productId,
      claimed.trial_id,
    );
    const expired = await validate(claimed.trial_token);
    expect(expired.status).toBe(200);
    expect((await expired.json() as any).data.state).toMatchObject({
      kind: "trial",
      status: "expired",
      code: "TRIAL_EXPIRED",
      expires_at: "2020-01-01T00:00:00.000Z",
      details: {
        trial_id: claimed.trial_id,
        expires_at: "2020-01-01T00:00:00.000Z",
      },
    });

    await run(
      `UPDATE trial_claims SET revoked_at = ?1, revoke_reason = 'abuse', updated_at = ?1
       WHERE instance_id = ?2 AND product_id = ?3 AND id = ?4`,
      new Date().toISOString(),
      instanceId,
      productId,
      claimed.trial_id,
    );
    const unauthenticated = await validate("ttk_" + "0".repeat(64));
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json() as any).error.code).toBe("TRIAL_CREDENTIALS_INVALID");
    const revoked = await validate(claimed.trial_token);
    expect(revoked.status).toBe(200);
    expect((await revoked.json() as any).data.state).toMatchObject({
      kind: "trial",
      status: "revoked",
      code: "TRIAL_REVOKED",
      reason: "abuse",
      details: {
        trial_id: claimed.trial_id,
        revoked_at: expect.any(String),
        revoke_reason: "abuse",
      },
    });
  });

  it("authenticates License credentials before returning business terminal states", async () => {
    await seedPlan({ id: "lpl_validation_states" });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licensePlanId: "lpl_validation_states",
      customerEmail: "states@example.com",
      actor: { type: "user", id: userId },
      now: new Date(),
    });
    const fingerprint = "sha256:license-state-device";
    const activated = await activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint,
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
    });
    const app = clientApp();
    const validate = (machineToken: string, releaseVersion = "1.0.0") => app.request(
      "https://license.example.test/api/v1/client/validate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: productId,
          fingerprint,
          release_version: releaseVersion,
          release_platform: "macos-universal",
          credential: {
            kind: "license",
            activation_id: activated.activation_id,
            machine_token: machineToken,
          },
        }),
      },
      testEnv.env,
    );

    const active = await validate(activated.machine_token);
    const activeBody = await active.json() as any;
    expect(active.status).toBe(200);
    expect(activeBody.data.state).toMatchObject({ kind: "license", status: "active" });
    expect(activeBody.data.credential_update).toEqual({
      credential_mode: "opaque",
      signed_license_token: null,
      signed_license_token_expires_at: null,
      signing_key_id: null,
    });
    expect(activeBody.data).not.toHaveProperty("machine_token");

    const unknownRelease = await validate(activated.machine_token, "9.9.9");
    expect((await unknownRelease.json() as any).data.state).toMatchObject({
      kind: "release_not_eligible",
      status: "unknown_release",
      code: "PRODUCT_RELEASE_UNKNOWN",
      details: {
        release_version: "9.9.9",
        release_platform: "macos-universal",
      },
    });

    await run(
      `UPDATE licenses SET status = 'suspended', status_reason = 'payment_review', updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3`,
      new Date().toISOString(),
      instanceId,
      issued.license.id,
    );
    const wrongToken = await validate("mtk_" + "0".repeat(64));
    expect(wrongToken.status).toBe(401);
    expect((await wrongToken.json() as any).error.code).toBe("ACTIVATION_CREDENTIALS_INVALID");
    const suspended = await validate(activated.machine_token);
    expect(suspended.status).toBe(200);
    expect((await suspended.json() as any).data.state).toMatchObject({
      kind: "license",
      status: "suspended",
      code: "LICENSE_SUSPENDED",
      reason: "payment_review",
      details: {
        license_id: issued.license.id,
        status_reason: "payment_review",
      },
    });

    await run(
      `UPDATE licenses SET status = 'revoked', status_reason = 'fraud', updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3`,
      new Date().toISOString(),
      instanceId,
      issued.license.id,
    );
    expect((await (await validate(activated.machine_token)).json() as any).data.state).toMatchObject({
      kind: "license",
      status: "revoked",
      code: "LICENSE_REVOKED",
      reason: "fraud",
      details: {
        license_id: issued.license.id,
        status_reason: "fraud",
      },
    });

    await run(
      `UPDATE licenses
       SET status = 'active', status_reason = NULL, license_model = 'fixed_term',
           renewal_mode = 'none', expires_at = '2020-01-01T00:00:00.000Z',
           updates_until = NULL, updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3`,
      new Date().toISOString(),
      instanceId,
      issued.license.id,
    );
    expect((await (await validate(activated.machine_token)).json() as any).data.state).toMatchObject({
      kind: "license",
      status: "expired",
      code: "LICENSE_EXPIRED",
      expires_at: "2020-01-01T00:00:00.000Z",
      details: {
        license_id: issued.license.id,
        expires_at: "2020-01-01T00:00:00.000Z",
        billing_period_expires_at: "2020-01-01T00:00:00.000Z",
        payment_grace_seconds: 0,
      },
    });

    await run(
      `UPDATE licenses
       SET license_model = 'perpetual', expires_at = NULL,
           updates_until = '2026-09-19T00:00:00.000Z', updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3`,
      new Date().toISOString(),
      instanceId,
      issued.license.id,
    );
    await run(
      `INSERT INTO product_releases (
         id, instance_id, product_id, version, platform, artifact_sha256,
         released_at, created_at, updated_at
       ) VALUES ('rel_v2_contract', ?1, ?2, '2.0.0', 'macos-universal', ?3, ?4, ?4, ?4)`,
      instanceId,
      productId,
      "c".repeat(64),
      "2026-10-01T00:00:00.000Z",
    );
    expect((await (await validate(activated.machine_token, "2.0.0")).json() as any).data.state).toMatchObject({
      kind: "release_not_eligible",
      status: "update_required",
      code: "UPDATE_ENTITLEMENT_REQUIRED",
      release_version: "2.0.0",
      release_platform: "macos-universal",
      updates_until: "2026-09-19T00:00:00.000Z",
      released_at: "2026-10-01T00:00:00.000Z",
      details: {
        license_id: issued.license.id,
        updates_until: "2026-09-19T00:00:00.000Z",
        release_version: "2.0.0",
        release_platform: "macos-universal",
        released_at: "2026-10-01T00:00:00.000Z",
      },
    });

    await run(
      `UPDATE activations SET status = 'deactivated', deactivated_at = ?1, updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3`,
      new Date().toISOString(),
      instanceId,
      activated.activation_id,
    );
    const deactivated = await validate(activated.machine_token);
    expect(deactivated.status).toBe(200);
    expect((await deactivated.json() as any).data.state).toEqual({
      kind: "license",
      status: "activation_deactivated",
      code: "ACTIVATION_DEACTIVATED",
      details: { activation_id: activated.activation_id },
    });

    await run(
      `UPDATE activations
       SET status = 'revoked', deactivated_at = NULL, revoked_at = ?1, updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3`,
      new Date().toISOString(),
      instanceId,
      activated.activation_id,
    );
    expect((await (await validate(activated.machine_token)).json() as any).data.state).toEqual({
      kind: "license",
      status: "activation_revoked",
      code: "ACTIVATION_REVOKED",
      details: { activation_id: activated.activation_id },
    });
  });

  it("keeps signed token lifetime independent from the validation interval", async () => {
    const keyId = "key_short_ttl";
    const keyPair = await generateEd25519KeyPair();
    const encrypted = await encryptEnvelopeV1(keyPair.privateKeyPkcs8Base64, testEnv.env, {
      instanceId,
      table: "signing_keys",
      rowId: keyId,
      field: "private_key_ciphertext",
    });
    await run(
      `INSERT INTO signing_keys (
         id, instance_id, product_id, algorithm, source, public_key,
         private_key_ciphertext, status, created_at, retired_at, revoked_at
       ) VALUES (?1, ?2, ?3, 'Ed25519', 'generated', ?4, ?5, 'active', ?6, NULL, NULL)`,
      keyId,
      instanceId,
      productId,
      keyPair.publicKeyBase64,
      encrypted,
      new Date().toISOString(),
    );

    const adminResponse = await adminLicensePlansApp().request("https://license.example.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: productId,
        name: "Short signed token",
        license_model: "perpetual",
        credential_mode: "signed",
        update_window_seconds: 7200,
        signed_token_ttl_seconds: 1,
        max_activations: 1,
        features: [],
      }),
    }, testEnv.env);
    expect(adminResponse.status).toBe(201);
    const plan = (await adminResponse.json() as any).data;
    expect(plan.signed_token_ttl_seconds).toBe(1);

    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licensePlanId: plan.id,
      customerEmail: "short-ttl@example.com",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-23T10:00:00.789Z"),
    });
    const activatedAt = new Date("2026-09-23T10:01:00.789Z");
    const activated = await activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint: "sha256:short-ttl-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: activatedAt,
    });
    expect(activated.signed_license_token_expires_at).toBe("2026-09-23T10:01:01.000Z");
    expect(activated.terms.updates_until).toBe("2026-09-23T12:00:00.000Z");
    expect(activated.state.terms.updates_until).toBe("2026-09-23T12:00:00.000Z");
    const claims = base64UrlToJson<any>(activated.signed_license_token!.split(".")[1]);
    expect(new Date(claims.exp * 1000).toISOString())
      .toBe(activated.signed_license_token_expires_at);
    expect(new Date(claims.upd * 1000).toISOString()).toBe(activated.terms.updates_until);

    const rejectedZeroTtl = await adminLicensePlansApp().request(
      `https://license.example.test/${plan.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_token_ttl_seconds: 0 }),
      },
      testEnv.env,
    );
    expect(rejectedZeroTtl.status).toBe(400);
    expect((await rejectedZeroTtl.json() as any).error.code)
      .toBe("LICENSE_PLAN_SIGNED_TTL_REQUIRED");

    const updated = await adminLicensePlansApp().request(
      `https://license.example.test/${plan.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_token_ttl_seconds: 2 }),
      },
      testEnv.env,
    );
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).data).toMatchObject({
      id: plan.id,
      signed_token_ttl_seconds: 2,
      affects_existing_licenses: false,
    });
  });

  it("uses the billing grace boundary for Client state and signed token expiry", async () => {
    const keyId = "key_billing_grace";
    const keyPair = await generateEd25519KeyPair();
    const encrypted = await encryptEnvelopeV1(keyPair.privateKeyPkcs8Base64, testEnv.env, {
      instanceId,
      table: "signing_keys",
      rowId: keyId,
      field: "private_key_ciphertext",
    });
    await run(
      `INSERT INTO signing_keys (
         id, instance_id, product_id, algorithm, source, public_key,
         private_key_ciphertext, status, created_at, retired_at, revoked_at
       ) VALUES (?1, ?2, ?3, 'Ed25519', 'generated', ?4, ?5, 'active', ?6, NULL, NULL)`,
      keyId,
      instanceId,
      productId,
      keyPair.publicKeyBase64,
      encrypted,
      "2026-09-19T09:00:00.000Z",
    );
    await run(
      "UPDATE products SET payment_grace_seconds = 300 WHERE instance_id = ?1 AND id = ?2",
      instanceId,
      productId,
    );
    await seedPlan({
      id: "lpl_billing_grace",
      model: "subscription",
      credential: "signed",
      signedTtl: 3600,
      paymentGrace: 300,
    });
    const issued = await issueManualLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      licensePlanId: "lpl_billing_grace",
      customerEmail: "grace@example.com",
      expiresAt: "2026-09-19T10:05:00.789Z",
      actor: { type: "user", id: userId },
      now: new Date("2026-09-19T10:00:00.000Z"),
    });
    await run(
      `INSERT INTO billing_providers (
         id, instance_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, api_secret_ciphertext, status, created_at, updated_at
       ) VALUES ('bpr_grace', ?1, 'paddle', 'sandbox', 'test_token',
         'encrypted', NULL, 'active', ?2, ?2)`,
      instanceId,
      "2026-09-19T10:00:00.000Z",
    );
    await run(
      `UPDATE licenses
       SET renewal_mode = 'billing', payment_grace_seconds = 300,
           source = 'payment', source_billing_provider_id = 'bpr_grace',
           source_external_transaction_id = 'txn_grace', updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3`,
      "2026-09-19T10:00:30.000Z",
      instanceId,
      issued.license.id,
    );
    const activated = await activateLicense({
      db: testEnv.d1,
      env: testEnv.env,
      instanceId,
      productId,
      licenseKey: issued.license.licenseKey,
      fingerprint: "sha256:grace-device",
      releaseVersion: "1.0.0",
      releasePlatform: "macos-universal",
      now: new Date("2026-09-19T10:06:00.000Z"),
    });
    expect(activated.license_expires_at).toBe("2026-09-19T10:10:00.000Z");
    expect(activated.state.expires_at).toBe("2026-09-19T10:10:00.000Z");
    const claims = base64UrlToJson<any>(activated.signed_license_token!.split(".")[1]);
    expect(claims.lexp).toBe(Date.parse("2026-09-19T10:10:00.000Z") / 1000);
    expect(new Date(claims.lexp * 1000).toISOString()).toBe(activated.license_expires_at);
    expect(claims.exp).toBe(Date.parse("2026-09-19T10:10:00.000Z") / 1000);
  });
});
