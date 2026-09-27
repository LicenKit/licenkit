import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppContext, InstanceRole } from "../src/types";
import { errorHandler } from "../src/middleware/error";
import {
  inspectAdminRoutePermissions,
  requireDeclaredAdminPermission,
  requireRole,
} from "../src/middleware/auth";
import { app as serverApp } from "../src/index";
import { adminAuditRouter } from "../src/routes/admin/audit.routes";
import { adminProductsRouter } from "../src/routes/admin/products.routes";
import { adminStatsRouter } from "../src/routes/admin/stats.routes";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const now = "2026-09-19T12:00:00.000Z";
const ALL_ROLES = ["owner", "admin", "member", "viewer"] as const;
const OWNER_ADMIN_MEMBER = ["owner", "admin", "member"] as const;
const OWNER_ADMIN = ["owner", "admin"] as const;
const OWNER_ONLY = ["owner"] as const;

const ALL_ROLE_ROUTE_KEYS = [
  "GET /api/v1/admin/audit-logs",
  "GET /api/v1/admin/billing/adjustments",
  "GET /api/v1/admin/billing/adjustments/:adjustmentId",
  "GET /api/v1/admin/billing/customers",
  "GET /api/v1/admin/billing/customers/:billingCustomerId",
  "GET /api/v1/admin/billing/events",
  "GET /api/v1/admin/billing/events/:eventId",
  "GET /api/v1/admin/billing/offers",
  "GET /api/v1/admin/billing/providers",
  "GET /api/v1/admin/billing/subscriptions",
  "GET /api/v1/admin/billing/subscriptions/:subscriptionId",
  "GET /api/v1/admin/customers",
  "GET /api/v1/admin/customers/:customerId",
  "GET /api/v1/admin/email-integrations",
  "GET /api/v1/admin/email-integrations/:integrationId/template-bindings",
  "GET /api/v1/admin/email-deliveries",
  "GET /api/v1/admin/email-deliveries/:deliveryId",
  "GET /api/v1/admin/email-template-contracts",
  "GET /api/v1/admin/email-template-contracts/:notificationType/versions/:contractVersion/examples/:provider",
  "GET /api/v1/admin/instance",
  "GET /api/v1/admin/invitations",
  "GET /api/v1/admin/license-plans",
  "GET /api/v1/admin/license-plans/:planId",
  "GET /api/v1/admin/licenses",
  "GET /api/v1/admin/licenses/:licenseId",
  "GET /api/v1/admin/licenses/:licenseId/activations",
  "GET /api/v1/admin/members",
  "GET /api/v1/admin/profile",
  "GET /api/v1/admin/products",
  "GET /api/v1/admin/products/:productId",
  "GET /api/v1/admin/stats",
  "GET /api/v1/admin/system/issues",
  "PATCH /api/v1/admin/profile",
  "POST /api/v1/admin/profile/password",
] as const;

const OWNER_ONLY_ROUTE_KEYS = [
  "PATCH /api/v1/admin/members/:userId",
  "POST /api/v1/admin/invitations",
  "POST /api/v1/admin/invitations/:invitationId/resend",
  "POST /api/v1/admin/invitations/:invitationId/revoke",
] as const;

const OWNER_ADMIN_MEMBER_ROUTE_KEYS = [
  "POST /api/v1/admin/licenses/:licenseId/activations/:activationId/revoke",
] as const;

const OWNER_ADMIN_ROUTE_KEYS = [
  "GET /api/v1/admin/products/:productId/releases",
  "GET /api/v1/admin/products/:productId/releases/:releaseId",
  "GET /api/v1/admin/products/:productId/trials",
  "GET /api/v1/admin/products/:productId/trials/:trialId",
  "PATCH /api/v1/admin/billing/offers/:offerId",
  "PATCH /api/v1/admin/billing/providers/:providerId",
  "PATCH /api/v1/admin/customers/:customerId",
  "PATCH /api/v1/admin/email-integrations/:integrationId",
  "PATCH /api/v1/admin/license-plans/:planId",
  "PATCH /api/v1/admin/products/:productId",
  "PATCH /api/v1/admin/products/:productId/releases/:releaseId",
  "POST /api/v1/admin/billing/adjustments/:adjustmentId/resolve",
  "POST /api/v1/admin/billing/customers/:billingCustomerId/reconcile",
  "POST /api/v1/admin/billing/events/:eventId/replay",
  "POST /api/v1/admin/billing/offers",
  "POST /api/v1/admin/billing/offers/:offerId/activate",
  "POST /api/v1/admin/billing/offers/:offerId/archive",
  "POST /api/v1/admin/billing/offers/:offerId/verification-config",
  "POST /api/v1/admin/billing/providers",
  "POST /api/v1/admin/billing/providers/:providerId/test",
  "POST /api/v1/admin/customers/:customerId/disable",
  "POST /api/v1/admin/customers/:customerId/enable",
  "POST /api/v1/admin/customers/:customerId/sessions/revoke",
  "POST /api/v1/admin/email-integrations",
  "POST /api/v1/admin/email-integrations/:integrationId/disable",
  "POST /api/v1/admin/email-integrations/:integrationId/enable",
  "POST /api/v1/admin/email-integrations/:integrationId/rotate-credential",
  "POST /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType/disable",
  "POST /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType/enable",
  "POST /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType/test",
  "POST /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType/retry-waiting",
  "POST /api/v1/admin/email-deliveries/:deliveryId/cancel",
  "POST /api/v1/admin/email-deliveries/:deliveryId/retry",
  "POST /api/v1/admin/license-plans",
  "POST /api/v1/admin/license-plans/:planId/archive",
  "POST /api/v1/admin/licenses",
  "POST /api/v1/admin/licenses/:licenseId/extend-updates",
  "POST /api/v1/admin/licenses/:licenseId/recover-key",
  "POST /api/v1/admin/licenses/:licenseId/reinstate",
  "POST /api/v1/admin/licenses/:licenseId/renew-term",
  "POST /api/v1/admin/licenses/:licenseId/revoke",
  "POST /api/v1/admin/licenses/:licenseId/security-reset",
  "POST /api/v1/admin/licenses/:licenseId/suspend",
  "POST /api/v1/admin/products",
  "POST /api/v1/admin/products/:productId/archive",
  "POST /api/v1/admin/products/:productId/releases",
  "POST /api/v1/admin/products/:productId/trials/:trialId/revoke",
  "POST /api/v1/admin/system/issues/:issueId/process",
  "PUT /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType",
] as const;

const EXPECTED_ROUTE_ROLES: ReadonlyMap<string, readonly InstanceRole[]> = new Map([
  ...ALL_ROLE_ROUTE_KEYS.map((key) => [key, ALL_ROLES] as const),
  ...OWNER_ONLY_ROUTE_KEYS.map((key) => [key, OWNER_ONLY] as const),
  ...OWNER_ADMIN_MEMBER_ROUTE_KEYS.map((key) => [key, OWNER_ADMIN_MEMBER] as const),
  ...OWNER_ADMIN_ROUTE_KEYS.map((key) => [key, OWNER_ADMIN] as const),
]);

function expectedRolesForAdminRoute(method: string, path: string): readonly InstanceRole[] {
  const key = `${method} ${path}`;
  const roles = EXPECTED_ROUTE_ROLES.get(key);
  if (!roles) throw new Error(`Mounted Admin route is missing from the expected RBAC table: ${key}`);
  return roles;
}

function auditApp(role?: InstanceRole, userId = "usr_member") {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_authz_test");
    c.set("instanceId", "ins_authz");
    if (role) c.set("instanceRole", role);
    c.set("userId", userId);
    c.set("userEmail", `${userId}@example.test`);
    await next();
  });
  app.route("/", adminAuditRouter);
  return app;
}

function statsApp(role: InstanceRole = "viewer") {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_stats_test");
    c.set("instanceId", "ins_authz");
    c.set("instanceRole", role);
    c.set("userId", "usr_other");
    c.set("userEmail", "usr_other@example.test");
    await next();
  });
  app.route("/", adminStatsRouter);
  return app;
}

function expectNoCamelCaseKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectNoCamelCaseKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    expect(key).not.toMatch(/[a-z][A-Z]/);
    expectNoCamelCaseKeys(item);
  }
}

function productsApp(role: InstanceRole) {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_product_authz_test");
    c.set("instanceId", "ins_authz");
    c.set("instanceRole", role);
    c.set("userId", "usr_other");
    c.set("userEmail", "usr_other@example.test");
    await next();
  });
  app.use("*", requireDeclaredAdminPermission);
  app.route("/", adminProductsRouter);
  return app;
}

function permissionDeclarationApp(declared: boolean) {
  const app = new Hono<AppContext>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("requestId", "req_permission_declaration_test");
    c.set("instanceId", "ins_authz");
    c.set("instanceRole", "owner");
    c.set("userId", "usr_other");
    c.set("userEmail", "usr_other@example.test");
    await next();
  });
  app.use("*", requireDeclaredAdminPermission);
  if (declared) {
    app.get("/", requireRole(["owner"]), (c) => c.json({ success: true }));
  } else {
    app.get("/", (c) => c.json({ success: true }));
  }
  return app;
}

describe("V1 admin authorization and audit visibility", () => {
  let testEnv: TestEnvContext;

  beforeEach(() => {
    testEnv = createTestEnv();
    const db = testEnv.sqliteDb;
    db.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES ('ins_authz', 'Authorization', 'https://authorization.example.test', 'https://license.example.test', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO products (
         id, instance_id, slug, name, billing_environment, trial_enabled,
         trial_features_json, status, created_at, updated_at
       ) VALUES ('prod_authz', 'ins_authz', 'authz-product', 'Authorization Product',
                 NULL, 0, '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES ('ins_foreign', 'Foreign Instance', 'https://foreign.example.test', 'https://foreign-license.example.test', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO products (
         id, instance_id, slug, name, billing_environment, trial_enabled,
         trial_features_json, status, created_at, updated_at
       ) VALUES ('prod_foreign', 'ins_foreign', 'foreign-product', 'Foreign Product',
                 NULL, 0, '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO product_releases (
         id, instance_id, product_id, version, platform, artifact_sha256,
         released_at, created_at, updated_at
       ) VALUES ('rel_authz', 'ins_authz', 'prod_authz', '1.0.0', 'macos-universal',
                 '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                 ?, ?, ?)`,
    ).run(now, now, now);
    for (const id of ["usr_member", "usr_other"]) {
      db.prepare(
        `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
         VALUES (?, ?, 'hash', ?, ?, ?)`,
      ).run(id, `${id}@example.test`, id, now, now);
    }
    db.prepare(
      `INSERT INTO audit_logs (
         id, scope_type, instance_id, actor_type, actor_user_id, action, resource_type,
         resource_id, request_id, details_redacted_json, ip, user_agent, created_at
       ) VALUES
         ('aud_self', 'instance', 'ins_authz', 'user', 'usr_member', 'license.read', 'license',
          'lic_self', 'req_self', '{"result":"allowed","resourceName":"License"}', '203.0.113.1', 'member-agent', ?),
         ('aud_other', 'instance', 'ins_authz', 'user', 'usr_other', 'billing.provider.update', 'billing_provider',
          'bpr_other', 'req_other', '{"result":"changed"}', '203.0.113.2', 'admin-agent', ?)`,
    ).run(now, now);
  });

  it("declares one permission set for every mounted Admin business route", () => {
    const inspection = inspectAdminRoutePermissions(serverApp.routes, {
      pathPrefix: "/api/v1/admin",
      excludedPathPrefixes: ["/api/v1/admin/auth"],
    });
    expect(inspection.undeclared).toEqual([]);
    expect(inspection.conflicts).toEqual([]);
    expect(inspection.declared).toHaveLength(EXPECTED_ROUTE_ROLES.size);

    for (const route of inspection.declared) {
      const expectedRoles = expectedRolesForAdminRoute(route.method, route.path);
      expect(
        route.allowedRoles,
        `${route.method} ${route.path} must follow the V1 Admin role matrix`,
      ).toEqual(expectedRoles);
      for (const role of ALL_ROLES) {
        expect(
          route.allowedRoles.includes(role),
          `${role} permission mismatch for ${route.method} ${route.path}`,
        ).toBe(expectedRoles.includes(role));
      }
    }
  });

  it("denies an admin route when no role was declared in the request context", async () => {
    const response = await auditApp().request("http://test/", {}, testEnv.env);
    expect(response.status).toBe(403);
  });

  it("denies an owner when the Admin route has no permission declaration", async () => {
    const denied = await permissionDeclarationApp(false).request("http://test/", {}, testEnv.env);
    expect(denied.status).toBe(403);
    const allowed = await permissionDeclarationApp(true).request("http://test/", {}, testEnv.env);
    expect(allowed.status).toBe(200);
  });

  it("limits members to their own audit results in the database query", async () => {
    const response = await auditApp("member").request("http://test/", {}, testEnv.env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data.items.map((item: any) => item.id)).toEqual(["aud_self"]);
    expect(body.data.items[0].instance_id).toBe("ins_authz");
    expect(body.data.items[0]).not.toHaveProperty("instanceId");
    expect(body.data.items[0].details).toEqual({ result: "allowed", resource_name: "License" });
    expectNoCamelCaseKeys(body);
  });

  it("returns viewers only a redacted summary", async () => {
    const response = await auditApp("viewer", "usr_other").request("http://test/", {}, testEnv.env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data.items).toHaveLength(2);
    for (const item of body.data.items) {
      expect(item).not.toHaveProperty("details");
      expect(item).not.toHaveProperty("ip");
      expect(item).not.toHaveProperty("user_agent");
      expect(item).not.toHaveProperty("request_id");
      expect(item.actor).toEqual({ type: "user" });
    }
    expectNoCamelCaseKeys(body);
  });

  it.each(["owner", "admin"] as const)("allows %s to read the full instance audit", async (role) => {
    const response = await auditApp(role, "usr_other").request("http://test/", {}, testEnv.env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0]).toHaveProperty("details");
    expect(body.data.items[0]).toHaveProperty("request_id");
    expectNoCamelCaseKeys(body);
  });

  it("rejects legacy camelCase audit query parameters", async () => {
    const response = await auditApp("owner", "usr_other")
      .request("http://test/?resourceType=license", {}, testEnv.env);
    expect(response.status).toBe(400);
  });

  it("returns Stats using only snake_case keys", async () => {
    const response = await statsApp().request("http://test/", {}, testEnv.env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data).toMatchObject({
      total_products: 1,
      total_licenses: 0,
      active_activations: 0,
      expiring_soon: 0,
      pending_inbound_events: 0,
      pending_deliveries: 0,
    });
    expectNoCamelCaseKeys(body);
  });

  it.each([
    ["owner", 200],
    ["admin", 200],
    ["member", 403],
    ["viewer", 403],
  ] as const)("enforces owner/admin-only Product Release reads for %s", async (role, expectedStatus) => {
    const app = productsApp(role);
    const list = await app.request("http://test/prod_authz/releases", {}, testEnv.env);
    const detail = await app.request("http://test/prod_authz/releases/rel_authz", {}, testEnv.env);
    expect(list.status).toBe(expectedStatus);
    expect(detail.status).toBe(expectedStatus);
  });

  it("returns not found when an Admin session probes another Instance's resource", async () => {
    const app = productsApp("owner");
    const own = await app.request("http://test/prod_authz", {}, testEnv.env);
    const foreign = await app.request("http://test/prod_foreign", {}, testEnv.env);
    expect(own.status).toBe(200);
    const ownBody = await own.json() as any;
    expect(ownBody.data.instance_id).toBe("ins_authz");
    expect(ownBody.data).not.toHaveProperty("instanceId");
    expectNoCamelCaseKeys(ownBody);
    expect(foreign.status).toBe(404);
    expect((await foreign.json() as any).error.code).toBe("NOT_FOUND");
  });

  it("rejects legacy camelCase Product input fields", async () => {
    const response = await productsApp("owner").request("http://test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "legacy-product-input",
        name: "Legacy Product Input",
        paymentGraceSeconds: 0,
      }),
    }, testEnv.env);
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe("VALIDATION_ERROR");
  });
});
