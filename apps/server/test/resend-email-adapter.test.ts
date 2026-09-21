import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/middleware/error";
import {
  EMAIL_PROVIDER_ADAPTERS,
  getEmailProviderAdapter,
  type EmailProviderAdapter,
  type EmailProviderErrorClassification,
  type EmailProviderSendInput,
} from "../src/infra/email/provider";
import {
  createResendEmailProviderAdapter,
  RESEND_SEND_EMAIL_URL,
} from "../src/infra/email/resend";

const MESSAGE_ID = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
const API_KEY = "re_test_secret_value";

function input(
  overrides: Partial<EmailProviderSendInput> = {},
): EmailProviderSendInput {
  return {
    credential: { version: 1, apiKey: API_KEY },
    from: "LicenKit <licenses@example.com>",
    to: "buyer@example.net",
    replyTo: "support@example.com",
    templateRef: "license-issued-v1",
    variables: {
      instance_name: "Example Team",
      license_key: "LIC-SECRET-VALUE",
      key_version: 2,
    },
    idempotencyKey: "delivery/dlv_00000000000000000000000000",
    ...overrides,
  } as EmailProviderSendInput;
}

function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function classifyRejected(
  adapter: EmailProviderAdapter,
  promise: Promise<unknown>,
): Promise<EmailProviderErrorClassification> {
  try {
    await promise;
    throw new Error("Expected the Provider request to fail");
  } catch (error) {
    return adapter.classifyError(error);
  }
}

describe("email Provider adapter registry", () => {
  it("registers Resend and fails fast when a Provider is not registered", () => {
    expect(Object.keys(EMAIL_PROVIDER_ADAPTERS)).toEqual(["resend"]);
    expect(getEmailProviderAdapter("resend").provider).toBe("resend");
    for (const provider of ["smtp", "toString", "__proto__"]) {
      try {
        getEmailProviderAdapter(provider);
        throw new Error("Expected an unregistered Provider error");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("EMAIL_PROVIDER_NOT_REGISTERED");
      }
    }
  });
});

describe("Resend email Provider adapter", () => {
  it("validates the versioned credential envelope without returning key material in failures", () => {
    const adapter = createResendEmailProviderAdapter();
    expect(adapter.validateCredentialEnvelope({ version: 1, apiKey: API_KEY })).toEqual({
      version: 1,
      apiKey: API_KEY,
    });
    for (const invalid of [
      null,
      { version: 2, apiKey: API_KEY },
      { version: 1, apiKey: "" },
      { version: 1, apiKey: API_KEY, extra: true },
    ]) {
      try {
        adapter.validateCredentialEnvelope(invalid);
        throw new Error("Expected invalid credentials");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("EMAIL_PROVIDER_CREDENTIAL_INVALID");
        expect(JSON.stringify(error)).not.toContain(API_KEY);
      }
    }
  });

  it("sends the documented template payload and headers to the fixed API URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { id: MESSAGE_ID },
        { headers: { "x-request-id": "req_accepted" } },
      ),
    ) as unknown as typeof fetch;
    const adapter = createResendEmailProviderAdapter({ fetchImpl });

    await expect(adapter.send(input())).resolves.toEqual({
      providerMessageId: MESSAGE_ID,
      providerRequestId: "req_accepted",
      httpStatus: 200,
      responseHeadersRedacted: { "x-request-id": "req_accepted" },
      responseBodyRedacted: JSON.stringify({ id: MESSAGE_ID }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = new Headers(request.headers);
    expect(url).toBe(RESEND_SEND_EMAIL_URL);
    expect(request.method).toBe("POST");
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe(
      "delivery/dlv_00000000000000000000000000",
    );
    expect(JSON.parse(String(request.body))).toEqual({
      from: "LicenKit <licenses@example.com>",
      to: "buyer@example.net",
      reply_to: "support@example.com",
      template: {
        id: "license-issued-v1",
        variables: {
          instance_name: "Example Team",
          license_key: "LIC-SECRET-VALUE",
          key_version: 2,
        },
      },
    });
  });

  it("rejects invalid addresses, template references, variables and idempotency keys before fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = createResendEmailProviderAdapter({ fetchImpl });
    const cases: Array<[Partial<EmailProviderSendInput>, string]> = [
      [{ from: "not-an-email" }, "EMAIL_PROVIDER_FROM_INVALID"],
      [{ to: "not-an-email" }, "EMAIL_PROVIDER_TO_INVALID"],
      [{ replyTo: "bad\n@example.com" }, "EMAIL_PROVIDER_REPLYTO_INVALID"],
      [{ templateRef: " " }, "EMAIL_PROVIDER_TEMPLATE_REF_INVALID"],
      [{ templateRef: "t".repeat(513) }, "EMAIL_PROVIDER_TEMPLATE_REF_INVALID"],
      [
        { variables: { unsafe: true } as unknown as Record<string, string> },
        "EMAIL_PROVIDER_VARIABLE_TYPE_INVALID",
      ],
      [{ idempotencyKey: "x".repeat(257) }, "EMAIL_PROVIDER_IDEMPOTENCY_KEY_INVALID"],
    ];
    for (const [overrides, code] of cases) {
      await expect(adapter.send(input(overrides))).rejects.toMatchObject({ code });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies locally invalid send input as configuration", async () => {
    const adapter = createResendEmailProviderAdapter({
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(
      classifyRejected(adapter, adapter.send(input({ to: "not-an-email" }))),
    ).resolves.toMatchObject({
      action: "fail_delivery",
      failureClass: "configuration",
      providerErrorCode: "EMAIL_PROVIDER_TO_INVALID",
    });
  });

  it("preserves credential error facts and blocks the Integration", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          name: "missing_api_key",
          code: "missing_api_key",
          message: "Missing API key in the authorization header.",
          request_id: "req_auth",
          future_field: "preserve-this-fact",
          api_key: API_KEY,
        },
        { status: 401 },
      ),
    ) as unknown as typeof fetch;
    const adapter = createResendEmailProviderAdapter({ fetchImpl });

    await expect(classifyRejected(adapter, adapter.send(input()))).resolves.toEqual({
      action: "block_integration",
      failureClass: "authentication",
      httpStatus: 401,
      providerErrorType: "missing_api_key",
      providerErrorCode: "missing_api_key",
      providerErrorDetail: "Missing API key in the authorization header.",
      providerRequestId: "req_auth",
      responseBodyRedacted: JSON.stringify({
        name: "missing_api_key",
        code: "missing_api_key",
        message: "Missing API key in the authorization header.",
        request_id: "req_auth",
        future_field: "preserve-this-fact",
        api_key: "[REDACTED]",
      }),
    });
  });

  it("uses structured errors and messages to distinguish Binding and Integration configuration", async () => {
    const responses = [
      jsonResponse(
        {
          name: "validation_error",
          message: "The template does not exist or is not published.",
        },
        { status: 422 },
      ),
      jsonResponse(
        {
          name: "validation_error",
          message: "The example.com domain is not verified. Please verify a domain.",
        },
        { status: 403 },
      ),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const adapter = createResendEmailProviderAdapter({ fetchImpl });

    const binding = await classifyRejected(adapter, adapter.send(input()));
    expect(binding).toMatchObject({
      action: "block_binding",
      failureClass: "configuration",
      httpStatus: 422,
      providerErrorType: "validation_error",
    });
    const integration = await classifyRejected(adapter, adapter.send(input()));
    expect(integration).toMatchObject({
      action: "block_integration",
      failureClass: "configuration",
      httpStatus: 403,
      providerErrorType: "validation_error",
    });
  });

  it("does not normalize an unknown 4xx response into an authentication failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { name: "future_error", message: "A new client error." },
        { status: 403 },
      ),
    ) as unknown as typeof fetch;
    const adapter = createResendEmailProviderAdapter({ fetchImpl });

    await expect(classifyRejected(adapter, adapter.send(input()))).resolves.toMatchObject({
      action: "fail_delivery",
      failureClass: "provider",
      httpStatus: 403,
      providerErrorType: "future_error",
    });
  });

  it("retries rate limiting with Retry-After but blocks quota exhaustion", async () => {
    const responses = [
      jsonResponse(
        {
          name: "rate_limit_exceeded",
          code: "provider_throttle",
          message: "Too many requests.",
        },
        {
          status: 429,
          headers: { "retry-after": "7", "x-request-id": "req_rate" },
        },
      ),
      jsonResponse(
        { name: "daily_quota_exceeded", message: "Daily quota exceeded." },
        { status: 429 },
      ),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const adapter = createResendEmailProviderAdapter({ fetchImpl });

    await expect(classifyRejected(adapter, adapter.send(input()))).resolves.toMatchObject({
      action: "retry",
      failureClass: "rate_limit",
      httpStatus: 429,
      providerErrorType: "rate_limit_exceeded",
      providerErrorCode: "provider_throttle",
      providerRequestId: "req_rate",
      retryAfter: "7",
    });
    await expect(classifyRejected(adapter, adapter.send(input()))).resolves.toMatchObject({
      action: "block_integration",
      failureClass: "quota",
      providerErrorType: "daily_quota_exceeded",
    });
  });

  it("distinguishes concurrent and payload-changing idempotency conflicts", async () => {
    const responses = [
      jsonResponse(
        {
          name: "concurrent_idempotent_requests",
          message: "A request with the same key is in progress.",
        },
        { status: 409 },
      ),
      jsonResponse(
        {
          name: "invalid_idempotent_request",
          message: "The request body does not match the original request.",
        },
        { status: 409 },
      ),
      jsonResponse(
        {
          name: "invalid_idempotency_key",
          message: "The idempotency key is invalid.",
        },
        { status: 400 },
      ),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const adapter = createResendEmailProviderAdapter({ fetchImpl });

    await expect(classifyRejected(adapter, adapter.send(input()))).resolves.toMatchObject({
      action: "retry",
      failureClass: "provider",
    });
    await expect(classifyRejected(adapter, adapter.send(input()))).resolves.toMatchObject({
      action: "fail_delivery",
      failureClass: "consistency",
    });
    await expect(classifyRejected(adapter, adapter.send(input()))).resolves.toMatchObject({
      action: "fail_delivery",
      failureClass: "configuration",
    });
  });

  it("retries 5xx, timeout and transport failures while redacting sensitive values", async () => {
    const serverAdapter = createResendEmailProviderAdapter({
      fetchImpl: vi.fn(async () =>
        jsonResponse(
          { name: "service_unavailable", message: "API is temporarily unavailable" },
          { status: 503 },
        ),
      ) as unknown as typeof fetch,
    });
    await expect(
      classifyRejected(serverAdapter, serverAdapter.send(input())),
    ).resolves.toMatchObject({
      action: "retry",
      failureClass: "provider",
      httpStatus: 503,
    });

    const timeoutFetch = vi.fn(
      (_url: RequestInfo | URL, request?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          request?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const timeoutAdapter = createResendEmailProviderAdapter({
      fetchImpl: timeoutFetch,
      timeoutMs: 1,
    });
    await expect(
      classifyRejected(timeoutAdapter, timeoutAdapter.send(input())),
    ).resolves.toMatchObject({
      action: "retry",
      failureClass: "timeout",
      providerErrorCode: "request_timeout",
    });

    const transportFetch = vi.fn(async () => {
      throw new TypeError(`socket failed for ${API_KEY} and LIC-SECRET-VALUE`);
    }) as unknown as typeof fetch;
    const transportAdapter = createResendEmailProviderAdapter({
      fetchImpl: transportFetch,
    });
    const transport = await classifyRejected(
      transportAdapter,
      transportAdapter.send(input()),
    );
    expect(transport).toMatchObject({
      action: "retry",
      failureClass: "transport",
      providerErrorCode: "TypeError",
    });
    expect(transport.providerErrorDetail).not.toContain(API_KEY);
    expect(transport.providerErrorDetail).not.toContain("LIC-SECRET-VALUE");
  });

  it("treats a 2xx response without a valid Email ID as a retryable protocol error", async () => {
    const responses = [jsonResponse({}), jsonResponse({ id: "bad\nidentifier" })];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const adapter = createResendEmailProviderAdapter({ fetchImpl });

    for (let index = 0; index < 2; index += 1) {
      await expect(classifyRejected(adapter, adapter.send(input()))).resolves.toMatchObject({
        action: "retry",
        failureClass: "provider",
        httpStatus: 200,
        providerErrorCode: "missing_or_invalid_email_id",
      });
    }
  });

  it("rejects sensitive response identifiers and drops unsafe request and retry metadata", async () => {
    const licenseKey = "LK-000000-000000-000000-000000-00";
    const magicToken = `mlk_${"a".repeat(64)}`;
    const responses = [
      jsonResponse(
        { id: licenseKey, request_id: "buyer@example.net" },
        {
          status: 202,
          headers: { "x-request-id": API_KEY },
        },
      ),
      jsonResponse(
        {
          name: "rate_limit_exceeded",
          code: "provider_throttle",
          message: "Too many requests.",
          request_id: magicToken,
        },
        {
          status: 429,
          headers: {
            "retry-after": "buyer@example.net",
            "x-request-id": API_KEY,
          },
        },
      ),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const adapter = createResendEmailProviderAdapter({ fetchImpl });
    const request = input({
      variables: {
        instance_name: "Example Team",
        recipient_email: "buyer@example.net",
        license_key: licenseKey,
        access_url: `https://site.example.test/auth#token=${magicToken}`,
      },
    });

    const protocol = await classifyRejected(adapter, adapter.send(request));
    expect(protocol).toMatchObject({
      action: "retry",
      failureClass: "provider",
      providerErrorCode: "missing_or_invalid_email_id",
    });
    expect(protocol.providerRequestId).toBeUndefined();
    expect(protocol.responseHeadersRedacted).toBeUndefined();
    expect(protocol.responseBodyRedacted).not.toContain(licenseKey);
    expect(protocol.responseBodyRedacted).not.toContain("buyer@example.net");

    const rateLimit = await classifyRejected(adapter, adapter.send(request));
    expect(rateLimit).toMatchObject({
      action: "retry",
      failureClass: "rate_limit",
    });
    expect(rateLimit.providerRequestId).toBeUndefined();
    expect(rateLimit.retryAfter).toBeUndefined();
    expect(rateLimit.responseHeadersRedacted).toBeUndefined();
    const persistedView = JSON.stringify(rateLimit);
    for (const secret of [licenseKey, magicToken, "buyer@example.net", API_KEY]) {
      expect(persistedView).not.toContain(secret);
    }
  });
});
