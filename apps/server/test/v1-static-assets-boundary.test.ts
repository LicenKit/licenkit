import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";

function testEnv(assetFetch = vi.fn(async (request: Request) => (
  new Response(new URL(request.url).pathname, { status: 200 })
))) {
  return {
    ENVIRONMENT: "test",
    ASSETS: { fetch: assetFetch },
  } as any;
}

describe("LicenKit static asset deployment boundary", () => {
  it("derives the Admin entry from the app root", async () => {
    const response = await app.request("https://license.example.test/", {}, testEnv());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/");
  });

  it("serves only the Admin path from the Worker asset binding", async () => {
    const assetFetch = vi.fn(async (request: Request) => (
      new Response(new URL(request.url).pathname, { status: 200 })
    ));
    const env = testEnv(assetFetch);

    const admin = await app.request("https://license.example.test/admin/", {}, env);
    const site = await app.request("https://license.example.test/products/example", {}, env);

    expect(admin.status).toBe(200);
    expect(await admin.text()).toBe("/admin/");
    expect(site.status).toBe(404);
    expect(assetFetch).toHaveBeenCalledTimes(1);
  });
});
