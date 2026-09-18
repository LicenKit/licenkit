import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { encryptEnvelope, generateEd25519KeyPair } from "../src/infra/crypto";
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
    await db.insert(schema.licenses).values({
      id: licenseId,
      accountId,
      productId,
      policyId,
      key: licenseKey,
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
    expect(body.data.token).toBeDefined();
    expect(body.data.policy.features).toEqual(["pro", "export"]);

    const rows = await db.select().from(schema.machines).where(eq(schema.machines.licenseId, licenseId)).all();
    expect(rows.length).toBe(1);
    expect(rows[0].fingerprint).toBe("fp_machine_alpha_01");
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
});
