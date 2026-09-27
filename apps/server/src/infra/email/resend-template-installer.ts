import type { EmailNotificationContract } from "../../domain/email/contracts";
import { AppError } from "../../middleware/error";
import type { EmailProviderTemplateExample } from "./provider-template-registry";
import { getEmailProviderAdapter } from "./provider";

const RESEND_TEMPLATES_URL = "https://api.resend.com/templates";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_IDENTIFIER_LENGTH = 512;

interface ResendTemplateResponse {
  readonly id: string;
  readonly alias?: string;
  readonly name?: string;
  readonly status?: "draft" | "published";
}

interface ResendApiResponse {
  readonly response: Response;
  readonly rawBody: string;
  readonly body?: Record<string, unknown>;
}

export interface ResendDefaultTemplateInstallInput {
  readonly apiKey: string;
  readonly integrationId: string;
  readonly contract: EmailNotificationContract;
  readonly example: EmailProviderTemplateExample;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface ResendDefaultTemplateInstallResult {
  readonly providerTemplateRef: string;
  readonly alias: string;
  readonly created: boolean;
  readonly published: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(
  value: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function sanitizeProviderText(value: string | undefined, apiKey: string): string | undefined {
  if (!value) return undefined;
  return value
    .replaceAll(apiKey, "[REDACTED_API_KEY]")
    .replace(/\bre_[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]")
    .replace(
      /\bLK-[0-9A-HJKMNP-TV-Z]{6}(?:-[0-9A-HJKMNP-TV-Z]{6}){3}-[0-9A-HJKMNP-TV-Z]{2}\b/g,
      "[REDACTED_LICENSE_KEY]",
    )
    .replace(/\b(?:mlk|ivk)_[0-9a-f]{64}\b/g, "[REDACTED_ONE_TIME_TOKEN]")
    .replace(/([?&#](?:token|access_token)=)[^\s&#"'<>\[\]]+/gi, "$1[REDACTED_TOKEN]")
    .replace(
      /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi,
      "[REDACTED_EMAIL]",
    )
    .slice(0, 2048);
}

function sanitizeProviderValue(value: unknown, apiKey: string): unknown {
  if (typeof value === "string") return sanitizeProviderText(value, apiKey) ?? "";
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderValue(item, apiKey));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      /authorization|cookie|password|secret|token|api[_-]?key/i.test(key)
        ? "[REDACTED]"
        : sanitizeProviderValue(nested, apiKey),
    ]),
  );
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROVIDER_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function responseRequestId(response: Response, body?: Record<string, unknown>): string | undefined {
  return safeIdentifier(optionalString(body, "request_id", "requestId")) ??
    safeIdentifier(response.headers.get("x-resend-request-id")) ??
    safeIdentifier(response.headers.get("x-request-id")) ??
    safeIdentifier(response.headers.get("request-id"));
}

function providerFailure(
  operation: string,
  result: ResendApiResponse,
  apiKey: string,
): AppError {
  const details = {
    provider: "resend",
    operation,
    httpStatus: result.response.status,
    providerErrorType: sanitizeProviderText(
      optionalString(result.body, "name", "type"),
      apiKey,
    ),
    providerErrorCode: sanitizeProviderText(optionalString(result.body, "code"), apiKey),
    providerErrorDetail: sanitizeProviderText(
      optionalString(result.body, "message") ?? result.response.statusText,
      apiKey,
    ),
    providerRequestId: responseRequestId(result.response, result.body),
    responseBodyRedacted: result.body
      ? JSON.stringify(sanitizeProviderValue(result.body, apiKey)).slice(0, 2048)
      : sanitizeProviderText(result.rawBody, apiKey),
  };
  return new AppError(
    "EMAIL_DEFAULT_TEMPLATE_INSTALL_PROVIDER_REJECTED",
    "Resend rejected the default template installation request.",
    result.response.status === 401 || result.response.status === 403 ? 400 : 502,
    details,
    details,
  );
}

function protocolFailure(
  operation: string,
  message: string,
  result?: ResendApiResponse,
): AppError {
  const details = {
    provider: "resend",
    operation,
    ...(result ? {
      httpStatus: result.response.status,
      providerRequestId: responseRequestId(result.response, result.body),
    } : {}),
  };
  return new AppError(
    "EMAIL_DEFAULT_TEMPLATE_INSTALL_PROVIDER_PROTOCOL_INVALID",
    message,
    502,
    details,
    details,
  );
}

async function requestResend(
  input: {
    apiKey: string;
    operation: string;
    url: string;
    method: "GET" | "POST";
    body?: Record<string, unknown>;
    fetchImpl: typeof fetch;
    timeoutMs: number;
  },
): Promise<ResendApiResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: controller.signal,
    });
    const rawBody = await response.text();
    return { response, rawBody, body: parseJsonRecord(rawBody) };
  } catch (error) {
    const details = {
      provider: "resend",
      operation: input.operation,
      outcome: timedOut ? "timeout" : "transport_error",
      originalErrorName: error instanceof Error ? error.name : "UnknownError",
      originalErrorMessage: sanitizeProviderText(
        error instanceof Error ? error.message : String(error),
        input.apiKey,
      ),
    };
    throw new AppError(
      timedOut
        ? "EMAIL_DEFAULT_TEMPLATE_INSTALL_TIMEOUT"
        : "EMAIL_DEFAULT_TEMPLATE_INSTALL_TRANSPORT_ERROR",
      timedOut
        ? "The Resend default template installation request timed out."
        : "The Resend default template installation request could not be completed.",
      502,
      details,
      details,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseTemplate(
  operation: string,
  result: ResendApiResponse,
): ResendTemplateResponse {
  const id = safeIdentifier(result.body?.id);
  if (!id) {
    throw protocolFailure(
      operation,
      "Resend returned a template response without a valid Template ID.",
      result,
    );
  }
  const alias = safeIdentifier(result.body?.alias);
  const name = safeIdentifier(result.body?.name);
  const status = result.body?.status;
  if (status !== undefined && status !== "draft" && status !== "published") {
    throw protocolFailure(
      operation,
      "Resend returned an unsupported template status.",
      result,
    );
  }
  return {
    id,
    ...(alias ? { alias } : {}),
    ...(name ? { name } : {}),
    ...(status ? { status } : {}),
  };
}

function templateIdentity(input: ResendDefaultTemplateInstallInput): {
  alias: string;
  name: string;
} {
  const integrationToken = input.integrationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(-12);
  if (!integrationToken) {
    throw new AppError(
      "EMAIL_DEFAULT_TEMPLATE_INSTALL_INTEGRATION_ID_INVALID",
      "The Email Integration ID cannot be used to build a Resend template alias.",
      500,
      { provider: "resend", integrationId: input.integrationId },
    );
  }
  const notificationToken = input.contract.notificationType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return {
    alias: `licenkit-${integrationToken}-${notificationToken}-v${input.contract.version}`,
    name: `LicenKit ${input.contract.notificationType} v${input.contract.version}`,
  };
}

async function getTemplate(
  input: ResendDefaultTemplateInstallInput,
  alias: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ template?: ResendTemplateResponse; result: ResendApiResponse }> {
  const result = await requestResend({
    apiKey: input.apiKey,
    operation: "get_template",
    url: `${RESEND_TEMPLATES_URL}/${encodeURIComponent(alias)}`,
    method: "GET",
    fetchImpl,
    timeoutMs,
  });
  if (result.response.status === 404) return { result };
  if (!result.response.ok) throw providerFailure("get_template", result, input.apiKey);
  return { template: parseTemplate("get_template", result), result };
}

function assertExpectedTemplateIdentity(
  template: ResendTemplateResponse,
  expected: { alias: string; name: string },
): void {
  if (template.alias !== expected.alias || template.name !== expected.name) {
    throw new AppError(
      "EMAIL_DEFAULT_TEMPLATE_INSTALL_ALIAS_CONFLICT",
      "The deterministic Resend template alias is already used by another template.",
      409,
      {
        provider: "resend",
        alias: expected.alias,
        expectedName: expected.name,
        actualName: template.name ?? null,
        providerTemplateRef: template.id,
      },
    );
  }
}

async function publishTemplate(
  input: ResendDefaultTemplateInstallInput,
  templateId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const result = await requestResend({
    apiKey: input.apiKey,
    operation: "publish_template",
    url: `${RESEND_TEMPLATES_URL}/${encodeURIComponent(templateId)}/publish`,
    method: "POST",
    fetchImpl,
    timeoutMs,
  });
  if (!result.response.ok) throw providerFailure("publish_template", result, input.apiKey);
  const published = parseTemplate("publish_template", result);
  if (published.id !== templateId) {
    throw protocolFailure(
      "publish_template",
      "Resend published a different Template ID than the requested template.",
      result,
    );
  }
}

export async function installResendDefaultTemplate(
  input: ResendDefaultTemplateInstallInput,
): Promise<ResendDefaultTemplateInstallResult> {
  getEmailProviderAdapter("resend").validateCredentialEnvelope({
    version: 1,
    apiKey: input.apiKey,
  });
  if (
    input.example.provider !== "resend" ||
    input.example.notificationType !== input.contract.notificationType ||
    input.example.contractVersion !== input.contract.version
  ) {
    throw new AppError(
      "EMAIL_DEFAULT_TEMPLATE_INSTALL_INPUT_MISMATCH",
      "The Resend template example does not match the requested email contract.",
      500,
      {
        provider: input.example.provider,
        notificationType: input.contract.notificationType,
        contractVersion: input.contract.version,
      },
    );
  }
  const fetchImpl = input.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AppError(
      "EMAIL_DEFAULT_TEMPLATE_INSTALL_TIMEOUT_INVALID",
      "The Resend template installation timeout must be greater than zero.",
      500,
      { provider: "resend" },
    );
  }
  const identity = templateIdentity(input);
  let found = await getTemplate(input, identity.alias, fetchImpl, timeoutMs);
  let template = found.template;
  let created = false;

  if (!template) {
    const createResult = await requestResend({
      apiKey: input.apiKey,
      operation: "create_template",
      url: RESEND_TEMPLATES_URL,
      method: "POST",
      body: {
        name: identity.name,
        alias: identity.alias,
        subject: input.example.subject,
        html: input.example.html,
        text: input.example.text,
        variables: input.contract.variables.map((variable) => ({
          key: variable.name,
          type: variable.type,
        })),
      },
      fetchImpl,
      timeoutMs,
    });
    if (createResult.response.status === 409) {
      found = await getTemplate(input, identity.alias, fetchImpl, timeoutMs);
      if (!found.template) {
        throw providerFailure("create_template", createResult, input.apiKey);
      }
      template = found.template;
    } else {
      if (!createResult.response.ok) {
        throw providerFailure("create_template", createResult, input.apiKey);
      }
      template = parseTemplate("create_template", createResult);
      created = true;
    }
  }

  if (!template) {
    throw protocolFailure(
      "create_template",
      "Resend did not return or persist the requested template.",
    );
  }
  if (!created) assertExpectedTemplateIdentity(template, identity);

  const needsPublish = created || template.status !== "published";
  if (needsPublish) {
    await publishTemplate(input, template.id, fetchImpl, timeoutMs);
  }

  return Object.freeze({
    providerTemplateRef: template.id,
    alias: identity.alias,
    created,
    published: needsPublish,
  });
}
