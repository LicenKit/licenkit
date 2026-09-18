import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { encryptEnvelope, generateEd25519KeyPair, hashLicenseKey, normalizeLicenseKey } from "../src/infra/crypto";
import * as schema from "../src/infra/db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

describe("Client Activation Concurrency & Atomic Seat Over-allocation Prevention", () => {
  let testEnv: TestEnvContext;
  let db: any;

  const accountId = "acc_concurrency_test";
  const productId = "prd_concurrency_app";
  const policyId = "pol_concurrency_limit_2";
  const licenseId = "lic_concurrent_test_123";
  const licenseKey = "TEST-CONCUR-AAAA-BBBB-CCCC";

  beforeEach(async () => {
    testEnv = createTestEnv();
    db = drizzle(testEnv.d1, { schema });

    const now = new Date().toISOString();
    const masterKey = testEnv.env.STORAGE_ENCRYPTION_KEY!;

    // 1. Seed System Settings
    await db.insert(schema.systemSettings).values({
      id: "current",
      instanceName: "LicenKit Concurrency Test",
      appUrl: "http://localhost:5173",
      apiBaseUrl: "http://localhost:8787/api/v1",
      allowSignup: false,
      createdAt: now,
      updatedAt: now,
    });

    const paymentConfigsEncrypted = await encryptEnvelope(JSON.stringify({}), masterKey);

    // 2. Seed Account
    await db.insert(schema.accounts).values({
      id: accountId,
      name: "Concurrency Test Org",
      slug: "concurrency-test-org",
      paymentConfigs: paymentConfigsEncrypted,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    // 3. Seed Product
    await db.insert(schema.products).values({
      id: productId,
      accountId,
      name: "Concurrency Protected App",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    // 4. Seed Product Crypto Key (Ed25519)
    const keyPair = await generateEd25519KeyPair();
    const keyMaterialEncrypted = await encryptEnvelope(keyPair.privateKeyPkcs8Base64, masterKey);
    await db.insert(schema.cryptoKeys).values({
      kid: "kid_concur_001",
      accountId,
      productId,
      algorithm: "Ed25519",
      source: "platform",
      publicKey: keyPair.publicKeyBase64,
      keyMaterial: keyMaterialEncrypted,
      isActive: true,
      createdAt: now,
    });

    // 5. Seed Policy with maxMachines = 2
    await db.insert(schema.policies).values({
      id: policyId,
      accountId,
      productId,
      name: "Pro 2-Seat Policy",
      maxMachines: 2,
      floating: false,
      strict: true,
      scheme: "ed25519",
      features: JSON.stringify(["pro", "export"]),
      metadata: "{}",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    // 6. Seed License
    const keyHash = await hashLicenseKey(normalizeLicenseKey(licenseKey));
    await db.insert(schema.licenses).values({
      id: licenseId,
      accountId,
      productId,
      policyId,
      keyHash,
      customerEmail: "user@example.com",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("should activate a machine successfully and return offline token", async () => {
    const res = await app.request("/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        license_key: licenseKey,
        fingerprint: "fp_machine_alpha_01",
        platform: "macos",
        name: "MacBook Pro Alpha",
      }),
    }, testEnv.env);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.activated).toBe(true);
    expect(body.data.machine_id).toBeDefined();
    expect(body.data.machine_token).toBeDefined();
    expect(body.data.machine_token).toMatch(/^mct_[0-9a-f]{64}$/);
    expect(body.data.token).toBeDefined();
    expect(body.data.policy.features).toEqual(["pro", "export"]);

    const rows = await db.select().from(schema.machines).where(eq(schema.machines.licenseId, licenseId)).all();
    expect(rows.length).toBe(1);
    expect(rows[0].fingerprint).toBe("fp_machine_alpha_01");
    expect(rows[0].tokenHash).toBeDefined();
  });

  it("should enforce seat limit sequentially when maxMachines is reached", async () => {
    // 1st activation
    const res1 = await app.request("/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        license_key: licenseKey,
        fingerprint: "fp_machine_seat_1",
      }),
    }, testEnv.env);
    expect(((await res1.json()) as any).success).toBe(true);

    // 2nd activation
    const res2 = await app.request("/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        license_key: licenseKey,
        fingerprint: "fp_machine_seat_2",
      }),
    }, testEnv.env);
    expect(((await res2.json()) as any).success).toBe(true);

    // 3rd activation - should exceed seat limit
    const res3 = await app.request("/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        license_key: licenseKey,
        fingerprint: "fp_machine_seat_3",
      }),
    }, testEnv.env);
    const body3 = (await res3.json()) as any;
    expect(body3.success).toBe(false);
    expect(body3.error.code).toBe("SEAT_LIMIT_EXCEEDED");
    expect(body3.error.message).toContain("Seat limit reached");

    const rows = await db.select().from(schema.machines).where(eq(schema.machines.licenseId, licenseId)).all();
    expect(rows.length).toBe(2);
  });

  it("should strictly prevent seat over-allocation under high concurrency (P0 Race Condition)", async () => {
    // Attempt 10 concurrent activations with 10 distinct fingerprints when maxMachines = 2
    const concurrentRequests = Array.from({ length: 10 }, (_, i) =>
      app.request("/api/v1/client/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          license_key: licenseKey,
          fingerprint: `fp_concurrent_device_${i}_${Date.now()}`,
          name: `Concurrent Device ${i}`,
        }),
      }, testEnv.env).then((res) => res.json() as Promise<any>)
    );

    const results = await Promise.all(concurrentRequests);

    const successes = results.filter((r) => r.success === true);
    const seatExceededFailures = results.filter(
      (r) => r.success === false && r.error?.code === "SEAT_LIMIT_EXCEEDED"
    );

    // Strictly verify seat limit
    expect(successes.length).toBe(2);
    expect(seatExceededFailures.length).toBe(8);

    // Verify database rows count
    const rows = await db.select().from(schema.machines).where(eq(schema.machines.licenseId, licenseId)).all();
    expect(rows.length).toBe(2);
  });

  it("should handle concurrent activations with the identical fingerprint gracefully (idempotent reuse)", async () => {
    const identicalFingerprint = "fp_same_hardware_device_100";

    // 5 concurrent requests from the exact same device
    const concurrentRequests = Array.from({ length: 5 }, () =>
      app.request("/api/v1/client/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          license_key: licenseKey,
          fingerprint: identicalFingerprint,
          name: "Same Device Parallel",
        }),
      }, testEnv.env).then((res) => res.json() as Promise<any>)
    );

    const results = await Promise.all(concurrentRequests);

    // All should succeed
    const successes = results.filter((r) => r.success === true);
    expect(successes.length).toBe(5);

    // All should share the exact same machine_id
    const machineIds = new Set(results.map((r) => r.data.machine_id));
    expect(machineIds.size).toBe(1);

    // Database must only have 1 machine record
    const rows = await db.select().from(schema.machines).where(eq(schema.machines.licenseId, licenseId)).all();
    expect(rows.length).toBe(1);
    expect(rows[0].fingerprint).toBe(identicalFingerprint);
  });

  it("should validate heartbeat with machine credentials and reject unauthorized attempts", async () => {
    // 1. Activate machine
    const actRes = await app.request("/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        license_key: licenseKey,
        fingerprint: "fp_validate_test_01",
        name: "Heartbeat Device",
      }),
    }, testEnv.env);

    const actBody = (await actRes.json()) as any;
    expect(actBody.success).toBe(true);
    const { machine_id, machine_token } = actBody.data;

    // 2. Validate with correct credentials
    const valRes = await app.request("/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        machine_id,
        machine_token,
        fingerprint: "fp_validate_test_01",
      }),
    }, testEnv.env);

    expect(valRes.status).toBe(200);
    const valBody = (await valRes.json()) as any;
    expect(valBody.success).toBe(true);
    expect(valBody.data.valid).toBe(true);

    // 3. Reject validation with incorrect machine_token
    const wrongTokenRes = await app.request("/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        machine_id,
        machine_token: "mct_0000000000000000000000000000000000000000000000000000000000000000",
        fingerprint: "fp_validate_test_01",
      }),
    }, testEnv.env);
    expect(wrongTokenRes.status).toBe(200);
    const wrongTokenBody = (await wrongTokenRes.json()) as any;
    expect(wrongTokenBody.data.valid).toBe(false);
    expect(wrongTokenBody.data.reason).toBe("UNAUTHORIZED_CREDENTIALS");

    // 4. Reject validation with mismatched fingerprint
    const wrongFpRes = await app.request("/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        machine_id,
        machine_token,
        fingerprint: "fp_tampered_hardware",
      }),
    }, testEnv.env);
    expect(wrongFpRes.status).toBe(200);
    const wrongFpBody = (await wrongFpRes.json()) as any;
    expect(wrongFpBody.data.valid).toBe(false);
    expect(wrongFpBody.data.reason).toBe("UNAUTHORIZED_CREDENTIALS");

    // 5. Reject validation with mismatched account_id
    const wrongAccRes = await app.request("/api/v1/client/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: "acc_malicious_attacker",
        machine_id,
        machine_token,
        fingerprint: "fp_validate_test_01",
      }),
    }, testEnv.env);
    expect(wrongAccRes.status).toBe(200);
    const wrongAccBody = (await wrongAccRes.json()) as any;
    expect(wrongAccBody.data.valid).toBe(false);
    expect(wrongAccBody.data.reason).toBe("LICENSE_INVALID_OR_REVOKED");
  });

  it("should deactivate seat with strict credential checks and free the occupied seat", async () => {
    // 1. Fill all 2 seats
    const actRes1 = await app.request("/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        license_key: licenseKey,
        fingerprint: "fp_deact_seat_1",
      }),
    }, testEnv.env);
    const actBody1 = (await actRes1.json()) as any;
    const machine1 = actBody1.data;

    const actRes2 = await app.request("/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        license_key: licenseKey,
        fingerprint: "fp_deact_seat_2",
      }),
    }, testEnv.env);
    expect(((await actRes2.json()) as any).success).toBe(true);

    // 3rd activation fails because seats are full
    const actRes3Fail = await app.request("/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        license_key: licenseKey,
        fingerprint: "fp_deact_seat_3",
      }),
    }, testEnv.env);
    expect(((await actRes3Fail.json()) as any).success).toBe(false);

    // 2. Reject deactivation when account_id is mismatched (cross-account kick attack prevention)
    const deactWrongAcc = await app.request("/api/v1/client/deactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: "acc_other_org",
        machine_id: machine1.machine_id,
        machine_token: machine1.machine_token,
        fingerprint: "fp_deact_seat_1",
      }),
    }, testEnv.env);
    expect(deactWrongAcc.status).toBe(401);

    // 3. Reject deactivation when fingerprint is mismatched (token-leak kick attack prevention)
    const deactWrongFp = await app.request("/api/v1/client/deactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        machine_id: machine1.machine_id,
        machine_token: machine1.machine_token,
        fingerprint: "fp_attacker_hardware",
      }),
    }, testEnv.env);
    expect(deactWrongFp.status).toBe(401);

    // 4. Reject deactivation with invalid machine_token
    const deactWrongToken = await app.request("/api/v1/client/deactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        machine_id: machine1.machine_id,
        machine_token: "invalid_machine_token_hash_mismatch",
        fingerprint: "fp_deact_seat_1",
      }),
    }, testEnv.env);
    expect(deactWrongToken.status).toBe(401);

    // 5. Successful deactivation with all correct credentials
    const deactSuccess = await app.request("/api/v1/client/deactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        machine_id: machine1.machine_id,
        machine_token: machine1.machine_token,
        fingerprint: "fp_deact_seat_1",
      }),
    }, testEnv.env);
    expect(deactSuccess.status).toBe(200);
    const deactSuccessBody = (await deactSuccess.json()) as any;
    expect(deactSuccessBody.success).toBe(true);
    expect(deactSuccessBody.data.deactivated).toBe(true);

    // Verify machine is deleted from database
    const macInDb = await db.select().from(schema.machines).where(eq(schema.machines.id, machine1.machine_id)).get();
    expect(macInDb).toBeUndefined();

    // 6. Now 3rd device can successfully activate since a seat was freed!
    const actRes3Success = await app.request("/api/v1/client/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        license_key: licenseKey,
        fingerprint: "fp_deact_seat_3",
      }),
    }, testEnv.env);
    expect(actRes3Success.status).toBe(200);
    expect(((await actRes3Success.json()) as any).success).toBe(true);
  });
});
