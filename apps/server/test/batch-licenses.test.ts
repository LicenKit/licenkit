import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { hashPassword, signJWT, encryptEnvelope, generateLicenseKey } from "../src/infra/crypto";
import * as schema from "../src/infra/db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { cleanExpiredUnusedLicenses, escapeCsvCell } from "../src/routes/admin/licenses.routes";

describe("M05.8 Batch License Issuance, Quota Truncation & 30-Day Auto-Revoke Tests", () => {
  let testEnv: TestEnvContext;
  let db: any;

  const accountId = "acc_batch_test";
  const ownerId = "usr_owner_batch";
  const ownerEmail = "owner-batch@example.com";
  let ownerToken: string;

  const productId = "prd_screenstudio";
  const policyId = "pol_annual_pro";

  beforeEach(async () => {
    testEnv = createTestEnv();
    db = drizzle(testEnv.d1, { schema });

    const now = new Date().toISOString();
    const jwtSecret = testEnv.env.JWT_SECRET!;
    const masterKey = testEnv.env.STORAGE_ENCRYPTION_KEY!;

    // 1. Seed System Settings
    await db.insert(schema.systemSettings).values({
      id: "current",
      instanceName: "LicenKit Batch Test",
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
      name: "Batch Test Org",
      slug: "batch-test-org",
      paymentConfigs: paymentConfigsEncrypted,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    // 3. Seed Owner User
    const passwordHash = await hashPassword("OwnerPassword123!");
    await db.insert(schema.users).values({
      id: ownerId,
      accountId,
      email: ownerEmail,
      name: "Batch Org Owner",
      role: "owner",
      passwordHash,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    ownerToken = await signJWT(
      {
        userId: ownerId,
        accountId,
        email: ownerEmail,
        role: "owner",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      jwtSecret
    );

    // 4. Seed Product & Policy
    await db.insert(schema.products).values({
      id: productId,
      accountId,
      name: "ScreenStudio",
      slug: "screenstudio",
      description: "Screen recorder app",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.policies).values({
      id: policyId,
      accountId,
      productId,
      name: "Annual Pro (3 Seats)",
      scheme: "ed25519",
      duration: 31536000,
      maxMachines: 3,
      strict: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  it("should issue a single license with optional / null customer email", async () => {
    const res = await app.request("/api/v1/admin/licenses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        productId,
        policyId,
        // No customerEmail provided
      }),
    }, testEnv.env);

    expect(res.status).toBe(201);
    const json = await res.json<any>();
    expect(json.success).toBe(true);
    expect(json.data.customerEmail).toBeNull();
    expect(json.data.source).toBe("manual");
    expect(json.data.key).toMatch(
      /^LIC-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{2}$/
    );

    // Verify in database
    const saved = await db
      .select()
      .from(schema.licenses)
      .where(eq(schema.licenses.id, json.data.id))
      .get();
    expect(saved).toBeDefined();
    expect(saved.customerEmail).toBeNull();
    expect(saved.source).toBe("manual");
  });

  it("should reject batch issue if count > 10 (Fail-Fast)", async () => {
    const res = await app.request("/api/v1/admin/licenses/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        productId,
        policyId,
        count: 11, // exceeds 10
      }),
    }, testEnv.env);

    expect(res.status).toBe(400);
    const json = await res.json<any>();
    expect(json.success).toBe(false);
  });

  it("should issue a batch of licenses successfully within limit", async () => {
    const res = await app.request("/api/v1/admin/licenses/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        productId,
        policyId,
        count: 5,
        customerEmail: "channel@partner.com",
      }),
    }, testEnv.env);

    expect(res.status).toBe(201);
    const json = await res.json<any>();
    expect(json.success).toBe(true);
    expect(json.data.items).toHaveLength(5);
    expect(json.data.actualCount).toBe(5);
    expect(json.data.requestedCount).toBe(5);
    expect(json.data.truncated).toBe(false);
    expect(json.data.batchId).toMatch(/^batch_/);

    const keys = json.data.items.map((it: any) => it.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(5);
  });

  it("should auto-truncate when quota of 100 unused manual keys is near, and reject when full", async () => {
    const now = new Date().toISOString();

    // 1. Pre-seed 95 unused manual licenses
    const seeds: any[] = [];
    for (let i = 0; i < 95; i++) {
      seeds.push({
        id: `lic_seed_${i}`,
        accountId,
        productId,
        policyId,
        keyHash: `hash_seed_${i}`,
        customerEmail: null,
        source: "manual",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.insert(schema.licenses).values(seeds);

    // 2. Request 10 licenses: only 5 slots remain before 100
    const resTruncate = await app.request("/api/v1/admin/licenses/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        productId,
        policyId,
        count: 10,
      }),
    }, testEnv.env);

    expect(resTruncate.status).toBe(201);
    const jsonTruncate = await resTruncate.json<any>();
    expect(jsonTruncate.success).toBe(true);
    expect(jsonTruncate.data.requestedCount).toBe(10);
    expect(jsonTruncate.data.actualCount).toBe(5);
    expect(jsonTruncate.data.truncated).toBe(true);
    expect(jsonTruncate.data.notice).toContain("100 unused manual license quota");
    expect(jsonTruncate.data.items).toHaveLength(5);

    // 3. Now 100 unused manual licenses exist; any further issuance should fail-fast
    const resFull = await app.request("/api/v1/admin/licenses/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        productId,
        policyId,
        count: 2,
      }),
    }, testEnv.env);

    expect(resFull.status).toBe(400);
    const jsonFull = await resFull.json<any>();
    expect(jsonFull.success).toBe(false);
    expect(jsonFull.error.code).toBe("MANUAL_LICENSE_LIMIT_EXCEEDED");

    // Single issue should also fail
    const resSingleFull = await app.request("/api/v1/admin/licenses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        productId,
        policyId,
      }),
    }, testEnv.env);
    expect(resSingleFull.status).toBe(400);

    // 4. Bind one machine seat to one of the licenses -> unused count drops to 99
    await db.insert(schema.machines).values({
      id: "mac_test_01",
      licenseId: "lic_seed_0",
      fingerprint: "hw_fingerprint_0001",
      tokenHash: "mock_token_hash",
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Now requesting 1 license should succeed again!
    const resRecovered = await app.request("/api/v1/admin/licenses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        productId,
        policyId,
      }),
    }, testEnv.env);
    expect(resRecovered.status).toBe(201);
  });

  it("should support revoking a license with a specific reason", async () => {
    // Create license
    const createRes = await app.request("/api/v1/admin/licenses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        productId,
        policyId,
        customerEmail: "refund@customer.com",
      }),
    }, testEnv.env);
    const { data: license } = await createRes.json<any>();

    // Revoke with reason
    const revokeRes = await app.request(`/api/v1/admin/licenses/${license.id}/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        reason: "Customer refunded through payment dispute",
      }),
    }, testEnv.env);

    expect(revokeRes.status).toBe(200);

    // Verify in database
    const saved = await db
      .select()
      .from(schema.licenses)
      .where(eq(schema.licenses.id, license.id))
      .get();
    expect(saved.status).toBe("revoked");
    expect(saved.revokeReason).toBe("Customer refunded through payment dispute");
  });

  it("should auto-revoke unused manual licenses older than 30 days via SQL pushdown", async () => {
    // SQLite datetime: 35 days ago
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Old unused license (older than 30d, 0 seats) -> SHOULD be revoked
    await db.insert(schema.licenses).values({
      id: "lic_old_unused",
      accountId,
      productId,
      policyId,
      keyHash: "hash_old_unused",
      customerEmail: null,
      source: "manual",
      status: "active",
      createdAt: thirtyFiveDaysAgo,
      updatedAt: thirtyFiveDaysAgo,
    });

    // 1b. Boundary case: exactly 30 days and 2 hours ago (within 30-31d window)
    // Under raw ISO string lexicographical comparison ("...T...Z" <= "... ..."), 'T' > ' ' would fail.
    // Standardizing via sqlite datetime() ensures this critical boundary is correctly cleaned.
    const thirtyDaysAndTwoHoursAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000)).toISOString();
    await db.insert(schema.licenses).values({
      id: "lic_threshold_unused",
      accountId,
      productId,
      policyId,
      keyHash: "hash_thrs_unused",
      customerEmail: null,
      source: "manual",
      status: "active",
      createdAt: thirtyDaysAndTwoHoursAgo,
      updatedAt: thirtyDaysAndTwoHoursAgo,
    });

    // 2. Old used license (older than 30d, but has machine seat) -> should NOT be revoked
    await db.insert(schema.licenses).values({
      id: "lic_old_used",
      accountId,
      productId,
      policyId,
      keyHash: "hash_old_used",
      customerEmail: null,
      source: "manual",
      status: "active",
      createdAt: thirtyFiveDaysAgo,
      updatedAt: thirtyFiveDaysAgo,
    });
    await db.insert(schema.machines).values({
      id: "mac_seat_for_old",
      licenseId: "lic_old_used",
      fingerprint: "hw_fingerprint_old_used",
      tokenHash: "mock_token_hash",
      lastHeartbeatAt: thirtyFiveDaysAgo,
      createdAt: thirtyFiveDaysAgo,
      updatedAt: thirtyFiveDaysAgo,
    });

    // 3. Recent unused license (10d ago) -> should NOT be revoked
    await db.insert(schema.licenses).values({
      id: "lic_recent_unused",
      accountId,
      productId,
      policyId,
      keyHash: "hash_recn_unused",
      customerEmail: null,
      source: "manual",
      status: "active",
      createdAt: tenDaysAgo,
      updatedAt: tenDaysAgo,
    });

    // Execute cleanup function
    const cleaned = await cleanExpiredUnusedLicenses(db, accountId);
    expect(cleaned).toBe(2);

    // Verify states
    const oldUnused = await db.select().from(schema.licenses).where(eq(schema.licenses.id, "lic_old_unused")).get();
    expect(oldUnused.status).toBe("revoked");
    expect(oldUnused.revokeReason).toBe("EXPIRED_30_DAYS_UNUSED");

    const thresholdUnused = await db.select().from(schema.licenses).where(eq(schema.licenses.id, "lic_threshold_unused")).get();
    expect(thresholdUnused.status).toBe("revoked");
    expect(thresholdUnused.revokeReason).toBe("EXPIRED_30_DAYS_UNUSED");

    const oldUsed = await db.select().from(schema.licenses).where(eq(schema.licenses.id, "lic_old_used")).get();
    expect(oldUsed.status).toBe("active");
    expect(oldUsed.revokeReason).toBeNull();

    const recentUnused = await db.select().from(schema.licenses).where(eq(schema.licenses.id, "lic_recent_unused")).get();
    expect(recentUnused.status).toBe("active");
  });

  it("should export CSV and support seatStatus filtering", async () => {
    const now = new Date().toISOString();
    // Insert 1 unused and 1 used
    await db.insert(schema.licenses).values([
      {
        id: "lic_csv_unused",
        accountId,
        productId,
        policyId,
        keyHash: "hash_csve_unused",
        customerEmail: "unused@example.com",
        source: "manual",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "lic_csv_used",
        accountId,
        productId,
        policyId,
        keyHash: "hash_csve_used",
        customerEmail: "used@example.com",
        source: "manual",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(schema.machines).values({
      id: "mac_for_csv_used",
      licenseId: "lic_csv_used",
      fingerprint: "hw_fingerprint_csv",
      tokenHash: "mock_token_hash",
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // 1. Export all
    const resAll = await app.request("/api/v1/admin/licenses/export", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
      },
    }, testEnv.env);

    expect(resAll.status).toBe(200);
    expect(resAll.headers.get("content-type")).toContain("text/csv");
    const csvAll = await resAll.text();
    expect(csvAll).toContain("lic_csv_unused");
    expect(csvAll).toContain("lic_csv_used");
    expect(csvAll).toContain("hash_csve_unused");
    expect(csvAll).toContain("hash_csve_used");

    // 2. Export only unused
    const resUnused = await app.request("/api/v1/admin/licenses/export?seatStatus=unused", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
      },
    }, testEnv.env);

    expect(resUnused.status).toBe(200);
    const csvUnused = await resUnused.text();
    expect(csvUnused).toContain("lic_csv_unused");
    expect(csvUnused).not.toContain("lic_csv_used");
  });

  it("should properly escape CSV cells and protect against CSV Formula Injection", () => {
    // 1. Basic cases
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
    expect(escapeCsvCell("SimpleText")).toBe("SimpleText");
    expect(escapeCsvCell(123)).toBe("123");

    // 2. Comma, quotes, newlines
    expect(escapeCsvCell("Name, with comma")).toBe('"Name, with comma"');
    expect(escapeCsvCell('Name with "quotes"')).toBe('"Name with ""quotes"""');
    expect(escapeCsvCell("Line1\nLine2")).toBe('"Line1\nLine2"');

    // 3. Formula Injection defense (=, +, -, @, \t, \r)
    expect(escapeCsvCell("=1+1")).toBe('"\'=1+1"');
    expect(escapeCsvCell("@SUM(A1:B2)")).toBe('"\'@SUM(A1:B2)"');
    expect(escapeCsvCell("-2+3")).toBe('"\'-2+3"');
    expect(escapeCsvCell("+calc")).toBe('"\'+calc"');
    expect(escapeCsvCell("\tcmd")).toBe('"\'\tcmd"');
  });

  it("should safely export CSV when database record contains potential formula injection", async () => {
    const now = new Date().toISOString();
    await db.insert(schema.licenses).values({
      id: "lic_formula_inject",
      accountId,
      productId,
      policyId,
      keyHash: "hash_form_injc",
      customerEmail: "=cmd|' /C calc'!A0@example.com",
      source: "manual",
      status: "active",
      revokeReason: "@DDE('cmd';'/c calc';'__test__')",
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request("/api/v1/admin/licenses/export", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
      },
    }, testEnv.env);

    expect(res.status).toBe(200);
    const csv = await res.text();
    // Verify formula-injected email was sanitized with prepended single quote and wrapped in double quotes
    expect(csv).toContain("\"'=cmd|' /C calc'!A0@example.com\"");
    // Verify revokeReason was also sanitized
    expect(csv).toContain("\"'@DDE('cmd';'/c calc';'__test__')\"");
  });
});
