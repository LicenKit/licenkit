import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { hashPassword, signJWT, encryptEnvelope } from "../src/infra/crypto";
import { redactSensitiveData } from "../src/infra/audit";
import * as schema from "../src/infra/db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

describe("Admin Audit Logs Service & API (M02.7)", () => {
  let testEnv: TestEnvContext;
  let db: any;

  const accountId = "acc_audit_test_01";
  const ownerId = "usr_owner_01";
  const ownerEmail = "owner@test.com";
  let ownerToken: string;

  beforeEach(async () => {
    testEnv = createTestEnv();
    db = drizzle(testEnv.d1, { schema });

    const now = new Date().toISOString();
    const jwtSecret = testEnv.env.JWT_SECRET!;
    const masterKey = testEnv.env.STORAGE_ENCRYPTION_KEY!;

    // 1. Seed System Settings
    await db.insert(schema.systemSettings).values({
      id: "current",
      instanceName: "LicenKit Test",
      appUrl: "http://localhost:5173",
      apiBaseUrl: "http://localhost:8787/api/v1",
      allowSignup: false,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Seed Account
    const paymentConfigsEncrypted = await encryptEnvelope(JSON.stringify({}), masterKey);
    await db.insert(schema.accounts).values({
      id: accountId,
      name: "Audit Test Org",
      slug: "audit-test-org",
      paymentConfigs: paymentConfigsEncrypted,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    // 3. Seed Owner User
    const passwordHash = await hashPassword("password123");
    await db.insert(schema.users).values({
      id: ownerId,
      accountId,
      email: ownerEmail,
      name: "Owner Admin",
      passwordHash,
      role: "owner",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    // 4. Generate Owner JWT
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
  });

  it("redactSensitiveData correctly masks sensitive passwords, keys, and tokens", () => {
    const rawData = {
      username: "admin",
      password: "SuperSecretPassword123!",
      nested: {
        privateKey: "-----BEGIN PRIVATE KEY-----...",
        key_material: "raw_bytes_here",
        safeValue: "ok_to_read",
      },
      list: [{ webhookSecret: "whsec_xyz", label: "my_hook" }],
    };

    const sanitized = redactSensitiveData(rawData);
    expect(sanitized.username).toBe("admin");
    expect(sanitized.password).toBe("[REDACTED]");
    expect(sanitized.nested.privateKey).toBe("[REDACTED]");
    expect(sanitized.nested.key_material).toBe("[REDACTED]");
    expect(sanitized.nested.safeValue).toBe("ok_to_read");
    expect(sanitized.list[0].webhookSecret).toBe("[REDACTED]");
    expect(sanitized.list[0].label).toBe("my_hook");
  });

  it("records auth.login audit log upon successful authentication", async () => {
    const res = await app.request(
      "/api/v1/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "192.168.1.100",
          "User-Agent": "Vitest/Agent",
        },
        body: JSON.stringify({
          email: ownerEmail,
          password: "password123",
        }),
      },
      testEnv.env
    );

    expect(res.status).toBe(200);

    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "auth.login"))
      .all();

    expect(logs.length).toBe(1);
    expect(logs[0].userId).toBe(ownerId);
    expect(logs[0].userEmail).toBe(ownerEmail);
    expect(logs[0].ip).toBe("192.168.1.100");
    expect(logs[0].userAgent).toBe("Vitest/Agent");
    expect(logs[0].resourceType).toBe("auth");
  });

  it("records audit logs across product and policy lifecycle actions", async () => {
    // 1. Create Product
    const prodRes = await app.request(
      "/api/v1/admin/products",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          name: "Audited Software",
          description: "Audit test software",
          trialDays: 14,
        }),
      },
      testEnv.env
    );

    expect(prodRes.status).toBe(201);
    const prodJson = await prodRes.json();
    const productId = prodJson.data.id;

    // Verify product.create audit log
    const prodLogs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, productId))
      .all();

    expect(prodLogs.length).toBe(1);
    expect(prodLogs[0].action).toBe("product.create");
    expect(prodLogs[0].resourceType).toBe("product");
    const prodDetails = JSON.parse(prodLogs[0].details);
    expect(prodDetails.name).toBe("Audited Software");
    // Ensure no private key leaked in details
    expect(prodDetails.privateKey).toBeUndefined();

    // 2. Create Policy
    const polRes = await app.request(
      "/api/v1/admin/policies",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          productId,
          name: "Standard License",
          scheme: "ed25519",
          maxMachines: 2,
        }),
      },
      testEnv.env
    );

    expect(polRes.status).toBe(201);
    const polJson = await polRes.json();
    const policyId = polJson.data.id;

    // Verify policy.create audit log
    const polLogs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, policyId))
      .all();

    expect(polLogs.length).toBe(1);
    expect(polLogs[0].action).toBe("policy.create");

    // 3. Issue License
    const licRes = await app.request(
      "/api/v1/admin/licenses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          productId,
          policyId,
          customerEmail: "buyer@domain.com",
        }),
      },
      testEnv.env
    );

    expect(licRes.status).toBe(201);
    const licJson = await licRes.json();
    const licenseId = licJson.data.id;

    // Verify license.create audit log
    const licLogs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, licenseId))
      .all();

    expect(licLogs.length).toBe(1);
    expect(licLogs[0].action).toBe("license.create");

    // 4. Revoke License
    const revokeRes = await app.request(
      `/api/v1/admin/licenses/${licenseId}/revoke`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
        },
      },
      testEnv.env
    );

    expect(revokeRes.status).toBe(200);

    const revokeLogs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "license.revoke"))
      .all();

    expect(revokeLogs.length).toBe(1);
    expect(revokeLogs[0].resourceId).toBe(licenseId);
  });

  it("GET /api/v1/admin/audit-logs rejects unauthorized requests", async () => {
    const res = await app.request("/api/v1/admin/audit-logs", {}, testEnv.env);
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/admin/audit-logs supports pagination and filtered pushdown queries", async () => {
    const now = new Date().toISOString();

    // Seed mock audit records directly
    await db.insert(schema.auditLogs).values([
      {
        id: "aud_01",
        accountId,
        userId: ownerId,
        userEmail: ownerEmail,
        action: "license.create",
        resourceType: "license",
        resourceId: "lic_01",
        details: JSON.stringify({ key: "LIC-1111" }),
        ip: "10.0.0.1",
        userAgent: "Agent/1",
        createdAt: "2026-09-17T10:00:00Z",
      },
      {
        id: "aud_02",
        accountId,
        userId: ownerId,
        userEmail: ownerEmail,
        action: "license.revoke",
        resourceType: "license",
        resourceId: "lic_01",
        details: JSON.stringify({ reason: "fraud" }),
        ip: "10.0.0.1",
        userAgent: "Agent/1",
        createdAt: "2026-09-17T10:05:00Z",
      },
      {
        id: "aud_03",
        accountId,
        userId: "usr_other_99",
        userEmail: "other@test.com",
        action: "product.create",
        resourceType: "product",
        resourceId: "prd_02",
        details: JSON.stringify({ name: "App 2" }),
        ip: "10.0.0.2",
        userAgent: "Agent/2",
        createdAt: "2026-09-17T10:10:00Z",
      },
    ]);

    // 1. Query all with pagination
    const resAll = await app.request(
      "/api/v1/admin/audit-logs?page=1&limit=2",
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
      testEnv.env
    );

    expect(resAll.status).toBe(200);
    const allJson = await resAll.json();
    expect(allJson.data.pagination.total).toBe(3);
    expect(allJson.data.pagination.totalPages).toBe(2);
    expect(allJson.data.items.length).toBe(2);
    // Ordered desc by createdAt
    expect(allJson.data.items[0].id).toBe("aud_03");
    expect(allJson.data.items[1].id).toBe("aud_02");

    // 2. Filter by action
    const resAction = await app.request(
      "/api/v1/admin/audit-logs?action=license.revoke",
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
      testEnv.env
    );
    const actionJson = await resAction.json();
    expect(actionJson.data.pagination.total).toBe(1);
    expect(actionJson.data.items[0].action).toBe("license.revoke");

    // 3. Filter by resourceType
    const resResType = await app.request(
      "/api/v1/admin/audit-logs?resourceType=product",
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
      testEnv.env
    );
    const resTypeJson = await resResType.json();
    expect(resTypeJson.data.pagination.total).toBe(1);
    expect(resTypeJson.data.items[0].resourceType).toBe("product");

    // 4. Filter by userId
    const resUser = await app.request(
      "/api/v1/admin/audit-logs?userId=usr_other_99",
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
      testEnv.env
    );
    const userJson = await resUser.json();
    expect(userJson.data.pagination.total).toBe(1);
    expect(userJson.data.items[0].userEmail).toBe("other@test.com");

    // 5. Filter by query (fuzzy search)
    const resSearch = await app.request(
      "/api/v1/admin/audit-logs?query=fraud",
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
      testEnv.env
    );
    // query searches email, action, resourceId
    const resSearch2 = await app.request(
      "/api/v1/admin/audit-logs?query=other@test.com",
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
      testEnv.env
    );
    const searchJson = await resSearch2.json();
    expect(searchJson.data.pagination.total).toBe(1);
    expect(searchJson.data.items[0].id).toBe("aud_03");
  });
});
