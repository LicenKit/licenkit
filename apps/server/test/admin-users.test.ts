import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";
import { hashPassword, signJWT, encryptEnvelope } from "../src/infra/crypto";
import * as schema from "../src/infra/db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

describe("Admin Users API & Tenancy / Role Guard Tests", () => {
  let testEnv: TestEnvContext;
  let db: any;

  const accountA = "acc_users_org_a";
  const accountB = "acc_users_org_b";

  const ownerAId = "usr_owner_org_a";
  const ownerAEmail = "owner-a@example.com";
  let ownerAToken: string;

  const memberAId = "usr_member_org_a";
  const memberAEmail = "member-a@example.com";

  const memberBId = "usr_member_org_b";
  const memberBEmail = "member-b@example.com";

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

    const paymentConfigsEncrypted = await encryptEnvelope(JSON.stringify({}), masterKey);

    // 2. Seed Org A and Org B
    await db.insert(schema.accounts).values([
      {
        id: accountA,
        name: "Org A",
        slug: "org-a",
        paymentConfigs: paymentConfigsEncrypted,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: accountB,
        name: "Org B",
        slug: "org-b",
        paymentConfigs: paymentConfigsEncrypted,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const passwordHash = await hashPassword("password123");

    // 3. Seed Users
    await db.insert(schema.users).values([
      // Org A users
      {
        id: ownerAId,
        accountId: accountA,
        email: ownerAEmail,
        name: "Owner A",
        passwordHash,
        role: "owner",
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: memberAId,
        accountId: accountA,
        email: memberAEmail,
        name: "Member A",
        passwordHash,
        role: "member",
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      // Org B users
      {
        id: memberBId,
        accountId: accountB,
        email: memberBEmail,
        name: "Member B",
        passwordHash,
        role: "member",
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // 4. Generate Owner A JWT
    ownerAToken = await signJWT(
      {
        userId: ownerAId,
        accountId: accountA,
        email: ownerAEmail,
        role: "owner",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      jwtSecret
    );
  });

  describe("PATCH /api/v1/admin/users/:id", () => {
    it("successfully updates a member within the same tenant", async () => {
      const res = await app.request(
        `/api/v1/admin/users/${memberAId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${ownerAToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Updated Member A", role: "admin" }),
        },
        testEnv.env
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.name).toBe("Updated Member A");
      expect(json.data.role).toBe("admin");

      const userInDb = await db.select().from(schema.users).where(eq(schema.users.id, memberAId)).get();
      expect(userInDb.name).toBe("Updated Member A");
      expect(userInDb.role).toBe("admin");
    });

    it("prevents updating a user from another tenant (tenant isolation)", async () => {
      const res = await app.request(
        `/api/v1/admin/users/${memberBId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${ownerAToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Hacked Member B" }),
        },
        testEnv.env
      );

      expect(res.status).toBe(404);

      // Verify Org B user was NOT modified
      const userInDb = await db.select().from(schema.users).where(eq(schema.users.id, memberBId)).get();
      expect(userInDb.name).toBe("Member B");
    });

    it("prevents demoting workspace owner", async () => {
      const res = await app.request(
        `/api/v1/admin/users/${ownerAId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${ownerAToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ role: "admin" }),
        },
        testEnv.env
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("CANNOT_DEMOTE_OWNER");
    });

    it("prevents deactivating oneself", async () => {
      const res = await app.request(
        `/api/v1/admin/users/${ownerAId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${ownerAToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        },
        testEnv.env
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("CANNOT_DEACTIVATE_SELF");
    });
  });

  describe("DELETE /api/v1/admin/users/:id", () => {
    it("successfully deletes a member within the same tenant", async () => {
      const res = await app.request(
        `/api/v1/admin/users/${memberAId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ownerAToken}` },
        },
        testEnv.env
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.message).toBe("User deleted successfully");

      const userInDb = await db.select().from(schema.users).where(eq(schema.users.id, memberAId)).get();
      expect(userInDb).toBeUndefined();
    });

    it("prevents deleting self (CANNOT_DELETE_SELF)", async () => {
      const res = await app.request(
        `/api/v1/admin/users/${ownerAId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ownerAToken}` },
        },
        testEnv.env
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("CANNOT_DELETE_SELF");
    });

    it("prevents deleting a user with role 'owner' (CANNOT_DELETE_OWNER)", async () => {
      // Seed a second owner into Org A to test the owner check specifically
      const secondOwnerId = "usr_second_owner_org_a";
      await db.insert(schema.users).values({
        id: secondOwnerId,
        accountId: accountA,
        email: "owner2-a@example.com",
        name: "Second Owner A",
        passwordHash: await hashPassword("password123"),
        role: "owner",
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const res = await app.request(
        `/api/v1/admin/users/${secondOwnerId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ownerAToken}` },
        },
        testEnv.env
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("CANNOT_DELETE_OWNER");

      // Verify the second owner was NOT deleted
      const userInDb = await db.select().from(schema.users).where(eq(schema.users.id, secondOwnerId)).get();
      expect(userInDb).toBeDefined();
    });

    it("prevents deleting a user from another tenant (tenant isolation)", async () => {
      const res = await app.request(
        `/api/v1/admin/users/${memberBId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ownerAToken}` },
        },
        testEnv.env
      );

      expect(res.status).toBe(404);

      // Verify Org B user was NOT deleted
      const userInDb = await db.select().from(schema.users).where(eq(schema.users.id, memberBId)).get();
      expect(userInDb).toBeDefined();
      expect(userInDb.id).toBe(memberBId);
    });
  });
});
