import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, formatApiError, queryString, snakeize } from "./api-client";

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
      name: "Desktop App",
      validationIntervalSeconds: 3600,
      trial: { enabled: true, durationSeconds: 3600, features: ["sync"] },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Desktop App",
      validation_interval_seconds: 3600,
      trial: { enabled: true, duration_seconds: 3600, features: ["sync"] },
    });
  });

  it("创建 Paddle 连接时只发送服务端创建契约允许的字段", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { id: "bpr_test", provider: "paddle", environment: "sandbox", status: "active" },
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.admin.billing.providers.create({
      provider: "paddle",
      environment: "sandbox",
      clientSideToken: "test_client_token",
      webhookSecret: "pdl_ntfset_test_secret",
      apiKey: "pdl_sdbx_apikey_test",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "paddle",
      environment: "sandbox",
      client_side_token: "test_client_token",
      webhook_secret: "pdl_ntfset_test_secret",
      api_key: "pdl_sdbx_apikey_test",
    });
  });

  it("更新 Product 时只发送可编辑字段", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { id: "prd_test", name: "Desktop Pro" },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.admin.products.update("prd_test", {
      name: "Desktop Pro",
      description: "Updated",
      trial: { enabled: true, durationSeconds: 604_800, features: ["sync"] },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Desktop Pro",
      description: "Updated",
      trial: { enabled: true, duration_seconds: 604_800, features: ["sync"] },
    });
  });

  it("递归转换数组对象并保持已有 snake_case 字段稳定", () => {
    expect(snakeize({ customerSiteUrl: "https://example.test", adminApiUrl: "https://license.example.test", setup_token: "secret", items: [{ productId: "prd_1" }] })).toEqual({
      customer_site_url: "https://example.test",
      admin_api_url: "https://license.example.test",
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

  it("formatApiError 输出英文错误码与友好中文说明", () => {
    const errorWithTranslation = new ApiError({
      code: "SETUP_CUSTOMER_SITE_CROSS_SITE_UNSUPPORTED",
      message: "Customer Site and LicenKit API must use the same schemeful site for SameSite=Lax Customer cookies",
      status: 400,
      method: "POST",
      path: "/api/v1/setup/complete",
      requestId: "req_123",
    });
    expect(formatApiError(errorWithTranslation)).toBe(
      "SETUP_CUSTOMER_SITE_CROSS_SITE_UNSUPPORTED: 官网地址必须与管理后台使用相同的主域名，且均为 HTTPS · req_123",
    );

    const errorUnknown = new ApiError({
      code: "UNKNOWN_CUSTOM_ERROR",
      message: "An unfamiliar internal error",
      status: 500,
      method: "GET",
      path: "/api/v1/test",
    });
    expect(formatApiError(errorUnknown)).toBe("UNKNOWN_CUSTOM_ERROR: An unfamiliar internal error");
  });

  it("formatApiError 默认展示上游服务返回的精确错误而不是只保留泛化文案", () => {
    const error = new ApiError({
      code: "EMAIL_DEFAULT_TEMPLATE_INSTALL_PROVIDER_REJECTED",
      message: "Resend rejected the default template installation request.",
      status: 502,
      method: "POST",
      path: "/api/v1/admin/email-integrations/emi_test/template-bindings/install-defaults",
      requestId: "req_licenkit",
      details: {
        provider: "resend",
        operation: "create_template",
        http_status: 429,
        provider_error_type: "rate_limit_exceeded",
        provider_error_code: "rate_limit_exceeded",
        provider_error_detail: "Too many requests. Please retry later.",
      },
    });

    expect(formatApiError(error)).toBe(
      "EMAIL_DEFAULT_TEMPLATE_INSTALL_PROVIDER_REJECTED: Resend 拒绝了模板安装请求 · resend · create_template · upstream HTTP 429 · rate_limit_exceeded: Too many requests. Please retry later. · req_licenkit",
    );
  });
});
