import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, queryString, snakeize } from "./api-client";

describe("Admin API JSON boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { cookie: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("递归把 JSON 请求字段转换为 snake_case", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: "prd_test" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.admin.products.create({
      slug: "desktop-app",
      name: "Desktop App",
      billingEnvironment: "sandbox",
      trial: { enabled: true, durationSeconds: 3600, features: ["sync"] },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      slug: "desktop-app",
      name: "Desktop App",
      billing_environment: "sandbox",
      trial: { enabled: true, duration_seconds: 3600, features: ["sync"] },
    });
  });

  it("递归转换数组对象并保持已有 snake_case 字段稳定", () => {
    expect(snakeize({ siteUrl: "https://example.test", setup_token: "secret", items: [{ productId: "prd_1" }] })).toEqual({
      site_url: "https://example.test",
      setup_token: "secret",
      items: [{ product_id: "prd_1" }],
    });
  });

  it("把 query 参数名转换为 snake_case 并保留 false 与 0", () => {
    const query = new URLSearchParams(queryString({ productId: "prd_1", customerId: "cus_1", includeArchived: false, page: 0 }).slice(1));
    expect(Object.fromEntries(query)).toEqual({
      product_id: "prd_1",
      customer_id: "cus_1",
      include_archived: "false",
      page: "0",
    });
  });

  it("错误 envelope 不读取 requestId 兼容别名", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: { code: "FAILED", message: "failed", requestId: "legacy-request-id" },
    }), { status: 400, statusText: "Bad Request" })));

    const caught = await api.setup.status().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).requestId).toBeNull();
  });
});
