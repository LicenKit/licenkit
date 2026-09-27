import { describe, expect, it, vi } from "vitest";
import { getEmailNotificationContract } from "../src/domain/email/contracts";
import { AppError } from "../src/middleware/error";
import { getEmailProviderTemplateExample } from "../src/infra/email/provider-template-registry";
import { installResendDefaultTemplate } from "../src/infra/email/resend-template-installer";

const API_KEY = "re_full_access_install_secret";
const INTEGRATION_ID = "emi_abc123";
const TEMPLATE_ID = "34a080c9-b17d-4187-ad80-5af20266e535";
const ALIAS = "licenkit-emiabc123-customer-license-issued-v1";
const NAME = "LicenKit customer.license_issued v1";

function install(fetchImpl: typeof fetch) {
  const contract = getEmailNotificationContract("customer.license_issued", 1);
  return installResendDefaultTemplate({
    apiKey: API_KEY,
    integrationId: INTEGRATION_ID,
    contract,
    example: getEmailProviderTemplateExample("resend", contract.notificationType, contract.version),
    fetchImpl,
  });
}

describe("Resend default template installer", () => {
  it("creates and publishes a code-defined template with all contract variables", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "not_found",
        message: "Template not found",
      }), { status: 404, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: "template",
        id: TEMPLATE_ID,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: "template",
        id: TEMPLATE_ID,
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await expect(install(fetchImpl)).resolves.toEqual({
      providerTemplateRef: TEMPLATE_ID,
      alias: ALIAS,
      created: true,
      published: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [getUrl, getInit] = (fetchImpl as any).mock.calls[0];
    expect(getUrl).toBe(`https://api.resend.com/templates/${ALIAS}`);
    expect(getInit).toMatchObject({
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const [createUrl, createInit] = (fetchImpl as any).mock.calls[1];
    expect(createUrl).toBe("https://api.resend.com/templates");
    const body = JSON.parse(createInit.body);
    expect(body).toMatchObject({
      name: NAME,
      alias: ALIAS,
      subject: "Your {{{product_name}}} license key",
    });
    expect(body.html).toContain("{{{license_key}}}");
    expect(body.text).toContain("{{{license_key}}}");
    expect(body.variables).toEqual(
      getEmailNotificationContract("customer.license_issued", 1).variables.map((variable) => ({
        key: variable.name,
        type: variable.type,
      })),
    );
    expect((fetchImpl as any).mock.calls[2][0]).toBe(
      `https://api.resend.com/templates/${TEMPLATE_ID}/publish`,
    );
  });

  it("reuses an already-published deterministic alias without modifying it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      object: "template",
      id: TEMPLATE_ID,
      alias: ALIAS,
      name: NAME,
      status: "published",
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await expect(install(fetchImpl)).resolves.toEqual({
      providerTemplateRef: TEMPLATE_ID,
      alias: ALIAS,
      created: false,
      published: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("publishes a recovered draft but never updates its content", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: "template",
        id: TEMPLATE_ID,
        alias: ALIAS,
        name: NAME,
        status: "draft",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: "template",
        id: TEMPLATE_ID,
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await expect(install(fetchImpl)).resolves.toMatchObject({
      providerTemplateRef: TEMPLATE_ID,
      created: false,
      published: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl as any).mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect((fetchImpl as any).mock.calls[1][1]).not.toHaveProperty("body");
  });

  it("preserves Resend diagnostics while redacting the temporary key", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Template not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "restricted_api_key",
        code: "invalid_permission",
        message: `Full access is required for ${API_KEY}`,
      }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "x-resend-request-id": "req_template_install",
          "retry-after": "1",
          "ratelimit-limit": "10",
          "ratelimit-remaining": "0",
          "ratelimit-reset": "1",
        },
      })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await install(fetchImpl);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: "EMAIL_DEFAULT_TEMPLATE_INSTALL_PROVIDER_REJECTED",
      status: 400,
      details: {
        provider: "resend",
        operation: "create_template",
        httpStatus: 403,
        providerErrorType: "restricted_api_key",
        providerErrorCode: "invalid_permission",
        providerRequestId: "req_template_install",
        providerRetryAfter: "1",
        providerRateLimitLimit: "10",
        providerRateLimitRemaining: "0",
        providerRateLimitReset: "1",
      },
    });
    expect(JSON.stringify((caught as AppError).details)).not.toContain(API_KEY);
    expect(JSON.stringify((caught as AppError).source)).not.toContain(API_KEY);
  });
});
