import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const API_ORIGIN = "https://license.example.test";
const CUSTOMER_SITE_ORIGIN = "https://site.example.test";

describe("V1 Customer cross-Origin boundary", () => {
  let testEnv: TestEnvContext;

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  async function preflight(
    path: string,
    origin = CUSTOMER_SITE_ORIGIN,
    method = "POST",
    headers = "content-type,x-csrf-token,x-request-id",
  ): Promise<Response> {
    return app.request(
      `${API_ORIGIN}${path}`,
      {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": headers,
        },
      },
      testEnv.env,
    );
  }

  async function completeSetup(siteOrigin = CUSTOMER_SITE_ORIGIN): Promise<void> {
    const response = await app.request(
      `${API_ORIGIN}/api/v1/setup`,
      {
        method: "POST",
        headers: { Origin: API_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({
          setup_token: testEnv.env.INITIAL_SETUP_TOKEN,
          user: {
            name: "Cross Origin Owner",
            email: "cross-origin-owner@example.test",
            password: "cross-origin-owner-password",
          },
          instance: {
            name: "Cross Origin",
            customer_site_url: siteOrigin,
            admin_api_url: API_ORIGIN,
          },
        }),
      },
      testEnv.env,
    );
    expect(response.status).toBe(201);
  }

  it.each([
    "/api/v1/customer/auth/magic-link",
    "/api/v1/customer/licenses/license-id/recover-key",
  ])("answers an allowed Customer preflight after Setup and before authentication for %s", async (path) => {
    await completeSetup();
    const response = await preflight(path);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(CUSTOMER_SITE_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Content-Type,X-CSRF-Token,X-Request-Id",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe("X-Request-Id");
    expect(response.headers.get("x-request-id")).toMatch(/^req_/);
    expect(response.headers.get("vary")?.toLowerCase()).toContain("origin");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("access-control-request-method");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("access-control-request-headers");
  });

  it.each([
    "https://site.example.test.evil.example",
    "https://evil-site.example.test",
    "http://site.example.test",
    "https://site.example.test/not-an-origin",
  ])("rejects the untrusted or malformed preflight Origin %s", async (origin) => {
    await completeSetup();
    const response = await preflight("/api/v1/customer/auth/magic-link", origin);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect((await response.json() as any).error.code).toMatch(
      /^CUSTOMER_ORIGIN_(?:INVALID|NOT_ALLOWED)$/,
    );
  });

  it("rejects methods and headers outside the Customer CORS contract", async () => {
    await completeSetup();
    const method = await preflight(
      "/api/v1/customer/licenses/license-id",
      CUSTOMER_SITE_ORIGIN,
      "PATCH",
    );
    expect(method.status).toBe(403);
    expect((await method.json() as any).error).toMatchObject({
      code: "CUSTOMER_CORS_METHOD_NOT_ALLOWED",
      details: { requested_method: "PATCH" },
    });

    const headers = await preflight(
      "/api/v1/customer/auth/magic-link",
      CUSTOMER_SITE_ORIGIN,
      "POST",
      "content-type,authorization",
    );
    expect(headers.status).toBe(403);
    expect((await headers.json() as any).error).toMatchObject({
      code: "CUSTOMER_CORS_HEADERS_NOT_ALLOWED",
      details: { rejected_headers: ["authorization"] },
    });

    const actualHead = await app.request(
      `${API_ORIGIN}/api/v1/customer/auth/config`,
      { method: "HEAD", headers: { Origin: CUSTOMER_SITE_ORIGIN } },
      testEnv.env,
    );
    expect(actualHead.status).toBe(403);
    expect(actualHead.headers.get("access-control-allow-origin")).toBe(CUSTOMER_SITE_ORIGIN);
    expect(actualHead.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it.each([
    "/api/v1/admin/auth/login",
    "/api/v1/client/licenses/validate",
    "/api/v1/webhooks/paddle/example",
  ])("does not grant Customer CORS to non-Customer path %s", async (path) => {
    const response = await preflight(path);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
  });

  it("rejects Customer API requests before Setup because no Instance host mapping exists", async () => {
    const response = await app.request(
      `${API_ORIGIN}/api/v1/customer/auth/config`,
      { headers: { Origin: CUSTOMER_SITE_ORIGIN, "X-Request-Id": "req_cross_origin" } },
      testEnv.env,
    );

    expect(response.status).toBe(403);
    expect((await response.json() as any).error.code).toBe("CUSTOMER_API_ORIGIN_NOT_CONFIGURED");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("req_cross_origin");
  });

  it("keeps an actual Customer 401 readable to the trusted Site", async () => {
    await completeSetup();
    const response = await app.request(
      `${API_ORIGIN}/api/v1/customer/auth/csrf-token`,
      { headers: { Origin: CUSTOMER_SITE_ORIGIN, "X-Request-Id": "req_customer_401" } },
      testEnv.env,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json() as any).error).toMatchObject({
      code: "UNAUTHORIZED",
      request_id: "req_customer_401",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(CUSTOMER_SITE_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-expose-headers")).toBe("X-Request-Id");
    expect(response.headers.get("x-request-id")).toBe("req_customer_401");
  });

  it("does not expose an actual Customer error to a disallowed Origin", async () => {
    await completeSetup();
    const response = await app.request(
      `${API_ORIGIN}/api/v1/customer/auth/config`,
      { headers: { Origin: "https://site.example.test.evil.example" } },
      testEnv.env,
    );

    expect(response.status).toBe(403);
    expect((await response.json() as any).error.code).toBe("CUSTOMER_ORIGIN_NOT_ALLOWED");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
  });

  it("keeps a cross-Origin GET fail-closed when Origin is missing", async () => {
    await completeSetup();
    const response = await app.request(
      `${API_ORIGIN}/api/v1/customer/auth/config`,
      { method: "GET" },
      testEnv.env,
    );

    expect(response.status).toBe(403);
    expect((await response.json() as any).error.code).toBe("CUSTOMER_ORIGIN_REQUIRED");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows a browser-style same-Origin GET without Origin but keeps POST fail-closed", async () => {
    testEnv = createTestEnv({
      TURNSTILE_SITE_KEY: "turnstile-same-origin",
    });
    await completeSetup(API_ORIGIN);

    const read = await app.request(
      `${API_ORIGIN}/api/v1/customer/auth/config`,
      { method: "GET" },
      testEnv.env,
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      success: true,
      data: { turnstile_site_key: "turnstile-same-origin" },
    });

    const write = await app.request(
      `${API_ORIGIN}/api/v1/customer/auth/magic-link`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "buyer@example.test",
          turnstile_token: "turnstile-token",
        }),
      },
      testEnv.env,
    );
    expect(write.status).toBe(403);
    expect((await write.json() as any).error.code).toBe("CUSTOMER_ORIGIN_REQUIRED");
  });
});
