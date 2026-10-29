import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";

type AssetEntry = { body: string; status?: number; contentType?: string; headers?: Record<string, string> };

function testEnv(files: Record<string, AssetEntry> = {}) {
  const entries: Record<string, AssetEntry> = {
    "/__site/builtin/site.json": { body: JSON.stringify({ apiBaseUrl: "/api/v1" }), contentType: "application/json" },
    "/__site/builtin/index.html": { body: "Site home", contentType: "text/html" },
    "/__site/builtin/404.html": { body: "Site not found", contentType: "text/html" },
    "/admin/index.html": { body: "Admin shell", contentType: "text/html" },
    ...files,
  };
  const assetFetch = vi.fn(async (request: Request) => {
    const entry = entries[new URL(request.url).pathname];
    if (!entry) return new Response("Not Found", { status: 404 });
    const status = entry.status ?? 200;
    return new Response(request.method === "HEAD" || [204, 304].includes(status) ? null : entry.body, {
      status,
      headers: { "Content-Type": entry.contentType ?? "text/plain", ...entry.headers },
    });
  });
  return { ENVIRONMENT: "test", ASSETS: { fetch: assetFetch }, assetFetch };
}

function requestedPaths(env: ReturnType<typeof testEnv>) {
  return env.assetFetch.mock.calls.map(([request]) => new URL(request.url).pathname);
}

describe("LicenKit Site and Admin static assets", () => {
  it("serves the Site homepage at the app root and keeps Admin at /admin/", async () => {
    const env = testEnv();
    const site = await app.request("https://license.example.test/", {}, env);
    const admin = await app.request("https://license.example.test/admin/", {}, env);
    expect(site.status).toBe(200);
    expect(await site.text()).toBe("Site home");
    expect(site.headers.get("location")).toBeNull();
    expect(site.headers.get("cache-control")).toBe("no-cache");
    expect(admin.status).toBe(200);
    expect(await admin.text()).toBe("Admin shell");
  });

  it("reads custom first and falls back only for a missing file", async () => {
    const env = testEnv({
      "/__site/custom/assets/logo.svg": { body: "custom logo", contentType: "image/svg+xml" },
      "/__site/builtin/assets/site.css": { body: "builtin styles", contentType: "text/css" },
    });
    const logo = await app.request("https://license.example.test/assets/logo.svg", {}, env);
    const css = await app.request("https://license.example.test/assets/site.css", {}, env);
    expect(await logo.text()).toBe("custom logo");
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(await css.text()).toBe("builtin styles");
    expect(requestedPaths(env)).toEqual(["/__site/custom/assets/logo.svg", "/__site/custom/assets/site.css", "/__site/builtin/assets/site.css"]);
  });

  it("applies page headers to uppercase HTML extensions accepted by the builder", async () => {
    const env = testEnv({ "/__site/custom/About.HTML": { body: "About", contentType: "text/html" } });
    const response = await app.request("https://license.example.test/About.HTML", {}, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("About");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const missing = await app.request("https://license.example.test/Missing.HTML", {}, env);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Site not found");
  });

  it("keeps an empty custom file and a custom read error without switching to builtin", async () => {
    const env = testEnv({
      "/__site/custom/assets/empty.css": { body: "", contentType: "text/css" },
      "/__site/builtin/assets/empty.css": { body: "should not be read" },
      "/__site/custom/assets/broken.js": { body: "asset service failed", status: 500 },
      "/__site/builtin/assets/broken.js": { body: "should not be read" },
    });
    const empty = await app.request("https://license.example.test/assets/empty.css", {}, env);
    const broken = await app.request("https://license.example.test/assets/broken.js", {}, env);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe("");
    expect(broken.status).toBe(500);
    expect(await broken.text()).toBe("asset service failed");
    expect(requestedPaths(env)).toEqual(["/__site/custom/assets/empty.css", "/__site/custom/assets/broken.js"]);
  });

  it("does not fall back when the asset service throws", async () => {
    const fetchAsset = vi.fn(async () => { throw new Error("asset read failed"); });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await app.request("https://license.example.test/assets/logo.svg", {}, { ENVIRONMENT: "production", ASSETS: { fetch: fetchAsset } });
      expect(response.status).toBe(500);
      expect(fetchAsset).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });

  it.each([
    ["/pricing", "pricing.html"], ["/purchase-success", "purchase-success.html"],
    ["/customer", "customer/index.html"], ["/customer/", "customer/index.html"],
    ["/customer/login", "customer/login.html"], ["/customer/auth", "customer/auth.html"],
    ["/customer/licenses/lcn_example", "customer/license.html"], ["/about", "about.html"], ["/help/", "help/index.html"],
  ])("maps %s to one file and supports a custom page", async (path, file) => {
    const env = testEnv({ [`/__site/custom/${file}`]: { body: file, contentType: "text/html" } });
    const response = await app.request(`https://license.example.test${path}`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(file);
    expect(requestedPaths(env)[0]).toBe(`/__site/custom/${file}`);
    expect(requestedPaths(env)).not.toContain(`/__site/builtin/${file}`);
    if (path.startsWith("/customer")) expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses a custom 404 page while preserving status and does not return HTML for a missing asset", async () => {
    const env = testEnv({ "/__site/custom/404.html": { body: "custom missing page", contentType: "text/html" } });
    const page = await app.request("https://license.example.test/missing-page", {}, env);
    const asset = await app.request("https://license.example.test/assets/missing.js", {}, env);
    expect(page.status).toBe(404);
    expect(await page.text()).toBe("custom missing page");
    expect(page.headers.get("content-type")).toBe("text/html");
    expect(asset.status).toBe(404);
    expect(asset.headers.get("content-type")).toContain("text/plain");
    expect(await asset.text()).toBe("Not Found");
  });

  it("does not turn a failed custom 404 read into an apparent normal 404", async () => {
    const env = testEnv({ "/__site/custom/404.html": { body: "failed", status: 500 } });
    const response = await app.request("https://license.example.test/missing-page", {}, env);
    expect(response.status).toBe(500);
    expect(requestedPaths(env)).not.toContain("/__site/builtin/404.html");
  });

  it.each(["/__site/custom/site.json", "/__site/builtin/index.html", "/api", "/.env", "/_headers", "/assets/%2e%2e%2fadmin/index.html", "/assets/%252e%252e%252fsecret", "/assets/%5csecret", "/assets//logo.svg", "/broken%zz"])("rejects reserved or invalid Site path %s without reading assets", async (path) => {
    const env = testEnv();
    const response = await app.request(`https://license.example.test${path}`, {}, env);
    expect(response.status).toBe(404);
    expect(env.assetFetch).not.toHaveBeenCalled();
  });

  it("does not accept business writes as static page requests", async () => {
    const env = testEnv();
    const response = await app.request("https://license.example.test/customer/auth", { method: "POST" }, env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(env.assetFetch).not.toHaveBeenCalled();
  });

  it("preserves HEAD and conditional asset responses without fetching builtin", async () => {
    const env = testEnv({ "/__site/custom/assets/site.css": { body: "", status: 304, headers: { ETag: '"custom"' } } });
    const response = await app.request("https://license.example.test/assets/site.css", { method: "HEAD", headers: { "If-None-Match": '"custom"' } }, env);
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe('"custom"');
    expect(env.assetFetch.mock.calls[0][0].method).toBe("HEAD");
    expect(env.assetFetch.mock.calls[0][0].headers.get("if-none-match")).toBe('"custom"');
    expect(env.assetFetch).toHaveBeenCalledTimes(1);
  });

  it("returns bodyless HEAD pages while reading configuration with an unconditional GET", async () => {
    const env = testEnv();
    const response = await app.request("https://license.example.test/", { method: "HEAD", headers: { "If-None-Match": '"old-page"' } }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    const request = env.assetFetch.mock.calls.at(-1)![0];
    expect(new URL(request.url).pathname).toBe("/__site/builtin/site.json");
    expect(request.method).toBe("GET");
    expect(request.headers.get("if-none-match")).toBeNull();
  });

  it("serves recovery and invitation pages directly from the Admin shell", async () => {
    const env = testEnv();
    for (const path of ["/admin/forgot-password", "/admin/reset-password", "/admin/recover-password", "/admin/invitations/accept"]) {
      const response = await app.request(`https://license.example.test${path}`, {}, env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("Admin shell");
      expect(response.headers.get("location")).toBeNull();
    }
    expect(requestedPaths(env)).toEqual(Array(4).fill("/admin/index.html"));
  });

  it("keeps real Admin assets under the Admin directory", async () => {
    const env = testEnv({ "/admin/assets/app.js": { body: "admin app", contentType: "text/javascript" } });
    const response = await app.request("https://license.example.test/admin/assets/app.js", {}, env);
    expect(await response.text()).toBe("admin app");
    expect(requestedPaths(env)).toEqual(["/admin/assets/app.js"]);
  });

  it("allows only the configured same-site API origin in CSP and selects custom configuration as a whole file", async () => {
    const env = testEnv({ "/__site/custom/site.json": { body: JSON.stringify({ apiBaseUrl: "https://api.example.test/api/v1" }), contentType: "application/json" } });
    const response = await app.request("https://license.example.test/", {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self' https://api.example.test");
    expect(response.headers.get("content-security-policy")).not.toContain("*.example.test");
    expect(requestedPaths(env)).not.toContain("/__site/builtin/site.json");
  });

  it.each(["broken json", JSON.stringify({ apiBaseUrl: "https://unrelated.test/api/v1" }), JSON.stringify({ apiBaseUrl: "https://user:pass@api.example.test/api/v1" }), JSON.stringify({ apiBaseUrl: "https://api.example.test/api/v1?token=secret" })])("reports invalid custom configuration without using builtin", async (body) => {
    const env = testEnv({ "/__site/custom/site.json": { body, contentType: "application/json" } });
    const response = await app.request("https://license.example.test/", {}, env);
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("SITE_CONFIGURATION_INVALID");
    expect(requestedPaths(env)).not.toContain("/__site/builtin/site.json");
  });

  it("limits third-party scripts to their relevant pages and keeps the auth page self-only", async () => {
    const files = Object.fromEntries(["pricing.html", "customer/login.html", "customer/auth.html"].map((file) => [`/__site/builtin/${file}`, { body: file, contentType: "text/html" }]));
    const env = testEnv(files);
    const pricing = await app.request("https://license.example.test/pricing", {}, env);
    const login = await app.request("https://license.example.test/customer/login", {}, env);
    const auth = await app.request("https://license.example.test/customer/auth", {}, env);
    expect(pricing.headers.get("content-security-policy")).toContain("script-src 'self' https://cdn.paddle.com");
    expect(pricing.headers.get("content-security-policy")).not.toContain("challenges.cloudflare.com");
    expect(login.headers.get("content-security-policy")).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(login.headers.get("content-security-policy")).not.toContain("paddle.com");
    expect(auth.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect(auth.headers.get("content-security-policy")).not.toContain("paddle.com");
    expect(auth.headers.get("content-security-policy")).not.toContain("challenges.cloudflare.com");
    expect(auth.headers.get("cache-control")).toBe("no-store");
  });
});
