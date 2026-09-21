import type { EmailVariableValue } from "../../domain/email/contracts";
import { AppError } from "../../middleware/error";
import { validateEmailProviderTemplateVariables } from "./provider-template-registry";
import type {
  EmailProviderAdapter,
  EmailProviderErrorClassification,
  EmailProviderSendInput,
  EmailProviderSendResult,
  ProviderCredential,
} from "./provider";

export const RESEND_SEND_EMAIL_URL = "https://api.resend.com/emails";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_PROVIDER_IDENTIFIER_LENGTH = 512;
const LICENKIT_MAX_TEMPLATE_REF_LENGTH = 512;
const EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

export interface ResendCredentialEnvelope extends ProviderCredential {
  readonly version: 1;
  readonly apiKey: string;
}

interface ResendProviderErrorFacts {
  readonly kind: "http" | "timeout" | "transport" | "protocol";
  readonly httpStatus?: number;
  readonly providerErrorType?: string;
  readonly providerErrorCode?: string;
  readonly providerErrorDetail?: string;
  readonly providerRequestId?: string;
  readonly retryAfter?: string;
  readonly responseHeadersRedacted?: Readonly<Record<string, string>>;
  readonly responseBodyRedacted?: string;
}

export class ResendEmailProviderError extends Error {
  readonly facts: ResendProviderErrorFacts;

  constructor(facts: ResendProviderErrorFacts) {
    super(facts.providerErrorDetail ?? "Resend email request failed.");
    this.name = "ResendEmailProviderError";
    this.facts = Object.freeze({ ...facts });
  }
}

export interface ResendEmailProviderAdapterOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function inputError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError(code, message, 400, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function sanitizeProviderText(
  value: string | undefined,
  sensitiveValues: readonly string[],
): string | undefined {
  if (!value) return undefined;
  let sanitized = value
    .replace(/\bre_[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]")
    .replace(
      /\bLK-[0-9A-HJKMNP-TV-Z]{6}(?:-[0-9A-HJKMNP-TV-Z]{6}){3}-[0-9A-HJKMNP-TV-Z]{2}\b/g,
      "[REDACTED_LICENSE_KEY]",
    )
    .replace(/\bmlk_[0-9a-f]{64}\b/g, "[REDACTED_MAGIC_LINK_TOKEN]")
    .replace(
      /([?&#](?:token|access_token)=)[^\s&#"'<>\[\]]+/gi,
      "$1[REDACTED_TOKEN]",
    )
    .replace(
      /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi,
      "[REDACTED_EMAIL]",
    );
  for (const sensitiveValue of [...new Set(sensitiveValues)]
    .filter((item) => item.length > 0)
    .sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.replaceAll(sensitiveValue, "[REDACTED]");
  }
  return sanitized.slice(0, 2048);
}

const SENSITIVE_PROVIDER_RESPONSE_KEYS =
  /(?:authorization|cookie|password|secret|token|license[_-]?key|api[_-]?key)/i;

function sanitizeProviderValue(
  value: unknown,
  sensitiveValues: readonly string[],
): unknown {
  if (typeof value === "string") {
    return sanitizeProviderText(value, sensitiveValues) ?? "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderValue(item, sensitiveValues));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_PROVIDER_RESPONSE_KEYS.test(key)
        ? "[REDACTED]"
        : sanitizeProviderValue(nested, sensitiveValues),
    ]),
  );
}

function sanitizeProviderBody(
  raw: string,
  parsed: Record<string, unknown> | undefined,
  sensitiveValues: readonly string[],
): string | undefined {
  if (!raw) return undefined;
  if (parsed) {
    return JSON.stringify(sanitizeProviderValue(parsed, sensitiveValues)).slice(0, 2048);
  }
  return sanitizeProviderText(raw, sensitiveValues);
}

function safeResponseHeaders(
  response: Response,
  sensitiveValues: readonly string[],
): Readonly<Record<string, string>> | undefined {
  const safe: Record<string, string> = {};
  const retryAfter = safeRetryAfter(
    response.headers.get("retry-after") ?? undefined,
    sensitiveValues,
  );
  if (retryAfter) safe["retry-after"] = retryAfter;
  for (const name of ["x-resend-request-id", "x-request-id", "request-id"]) {
    const raw = response.headers.get(name);
    const value = safeProviderIdentifier(raw ?? undefined, sensitiveValues);
    if (value) safe[name] = value;
  }
  return Object.keys(safe).length > 0 ? Object.freeze(safe) : undefined;
}

function requestIdFrom(
  response: Response,
  body: Record<string, unknown> | undefined,
  sensitiveValues: readonly string[],
): string | undefined {
  for (const candidate of [
    optionalString(body, "request_id", "requestId"),
    response.headers.get("x-resend-request-id") ?? undefined,
    response.headers.get("x-request-id") ?? undefined,
    response.headers.get("request-id") ?? undefined,
  ]) {
    const safe = safeProviderIdentifier(candidate, sensitiveValues);
    if (safe) return safe;
  }
  return undefined;
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

function validProviderIdentifier(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROVIDER_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function safeProviderIdentifier(
  value: string | undefined,
  sensitiveValues: readonly string[],
): string | undefined {
  if (!validProviderIdentifier(value)) return undefined;
  const sanitized = sanitizeProviderText(value, sensitiveValues);
  return sanitized === value ? value : undefined;
}

function safeRetryAfter(
  value: string | undefined,
  sensitiveValues: readonly string[],
): string | undefined {
  if (!value || sanitizeProviderText(value, sensitiveValues) !== value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? value : undefined;
  }
  if (
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) &&
    Number.isFinite(Date.parse(value))
  ) {
    return value;
  }
  return undefined;
}

function requireMailbox(value: unknown, field: "from" | "to" | "replyTo"): void {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    /[\r\n]/.test(value)
  ) {
    throw inputError(
      `EMAIL_PROVIDER_${field.toUpperCase()}_INVALID`,
      `The Resend ${field} address is invalid.`,
      { provider: "resend", field },
    );
  }
  const friendlyAddress = value.match(/^[^<>\r\n]*<([^<>\r\n]+)>$/)?.[1];
  if (!EMAIL_PATTERN.test(friendlyAddress ?? value)) {
    throw inputError(
      `EMAIL_PROVIDER_${field.toUpperCase()}_INVALID`,
      `The Resend ${field} address is invalid.`,
      { provider: "resend", field },
    );
  }
}

function validateIdempotencyKey(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    /[\r\n]/.test(value)
  ) {
    throw inputError(
      "EMAIL_PROVIDER_IDEMPOTENCY_KEY_INVALID",
      "The Resend idempotency key must contain between 1 and 256 characters.",
      { provider: "resend", maxLength: MAX_IDEMPOTENCY_KEY_LENGTH },
    );
  }
}

function validateCredentialEnvelope(value: unknown): ResendCredentialEnvelope {
  if (!isRecord(value)) {
    throw inputError(
      "EMAIL_PROVIDER_CREDENTIAL_INVALID",
      "The Resend credential envelope is invalid.",
      { provider: "resend" },
    );
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "apiKey" ||
    keys[1] !== "version" ||
    value.version !== 1 ||
    typeof value.apiKey !== "string" ||
    value.apiKey.length === 0 ||
    /\s/.test(value.apiKey)
  ) {
    throw inputError(
      "EMAIL_PROVIDER_CREDENTIAL_INVALID",
      "The Resend credential envelope is invalid.",
      { provider: "resend", supportedVersion: 1 },
    );
  }
  return Object.freeze({ version: 1, apiKey: value.apiKey });
}

function validateVariablesRecord(
  variables: unknown,
): void {
  if (!isRecord(variables)) {
    throw inputError(
      "EMAIL_PROVIDER_VARIABLES_INVALID",
      "Resend template variables must be an object.",
      { provider: "resend" },
    );
  }
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw inputError(
        "EMAIL_PROVIDER_VARIABLE_TYPE_INVALID",
        "A Resend template variable has an unsupported value type.",
        { provider: "resend", variable: name },
      );
    }
  }
  validateEmailProviderTemplateVariables(
    "resend",
    variables as Readonly<Record<string, EmailVariableValue>>,
  );
}

function validateSendInput(
  input: Omit<EmailProviderSendInput, "credential" | "idempotencyKey">,
): void {
  requireMailbox(input.from, "from");
  requireMailbox(input.to, "to");
  if (input.replyTo !== undefined) requireMailbox(input.replyTo, "replyTo");
  if (
    typeof input.templateRef !== "string" ||
    input.templateRef.length === 0 ||
    input.templateRef.length > LICENKIT_MAX_TEMPLATE_REF_LENGTH ||
    input.templateRef !== input.templateRef.trim() ||
    /[\u0000-\u001f\u007f]/.test(input.templateRef)
  ) {
    throw inputError(
      "EMAIL_PROVIDER_TEMPLATE_REF_INVALID",
      "The Resend template reference must be a non-empty ID or alias within the LicenKit length limit.",
      { provider: "resend", maxLength: LICENKIT_MAX_TEMPLATE_REF_LENGTH },
    );
  }
  validateVariablesRecord(input.variables);
}

function sensitiveValues(input: EmailProviderSendInput): string[] {
  return [
    (input.credential as Partial<ResendCredentialEnvelope>).apiKey ?? "",
    input.from,
    input.to,
    input.replyTo ?? "",
    ...Object.entries(input.variables).flatMap(([name, value]) =>
      typeof value === "string" &&
      /(?:email|key|token|url|secret|password)/i.test(name)
        ? [value]
        : []),
  ];
}

function localErrorClassification(error: AppError): EmailProviderErrorClassification {
  if (error.code === "EMAIL_PROVIDER_CREDENTIAL_INVALID") {
    return {
      action: "block_integration",
      failureClass: "authentication",
      providerErrorCode: error.code,
      providerErrorDetail: error.message,
    };
  }
  if (
    error.code.includes("TEMPLATE") ||
    error.code.includes("VARIABLE")
  ) {
    return {
      action: "block_binding",
      failureClass: "configuration",
      providerErrorCode: error.code,
      providerErrorDetail: error.message,
    };
  }
  if (error.code.includes("FROM") || error.code.includes("REPLYTO")) {
    return {
      action: "block_integration",
      failureClass: "configuration",
      providerErrorCode: error.code,
      providerErrorDetail: error.message,
    };
  }
  return {
    action: "fail_delivery",
    failureClass: "configuration",
    providerErrorCode: error.code,
    providerErrorDetail: error.message,
  };
}

function classifyResendError(error: unknown): EmailProviderErrorClassification {
  if (error instanceof AppError) return localErrorClassification(error);
  if (!(error instanceof ResendEmailProviderError)) {
    return {
      action: "fail_delivery",
      failureClass: "provider",
      providerErrorDetail: "Unrecognized email Provider error.",
    };
  }

  const { facts } = error;
  const base = {
    ...(facts.httpStatus === undefined ? {} : { httpStatus: facts.httpStatus }),
    ...(facts.providerErrorType === undefined
      ? {}
      : { providerErrorType: facts.providerErrorType }),
    ...(facts.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: facts.providerErrorCode }),
    ...(facts.providerErrorDetail === undefined
      ? {}
      : { providerErrorDetail: facts.providerErrorDetail }),
    ...(facts.providerRequestId === undefined
      ? {}
      : { providerRequestId: facts.providerRequestId }),
    ...(facts.retryAfter === undefined ? {} : { retryAfter: facts.retryAfter }),
    ...(facts.responseHeadersRedacted === undefined
      ? {}
      : { responseHeadersRedacted: facts.responseHeadersRedacted }),
    ...(facts.responseBodyRedacted === undefined
      ? {}
      : { responseBodyRedacted: facts.responseBodyRedacted }),
  };

  if (facts.kind === "timeout") {
    return { ...base, action: "retry", failureClass: "timeout" };
  }
  if (facts.kind === "transport") {
    return { ...base, action: "retry", failureClass: "transport" };
  }
  if (facts.kind === "protocol") {
    return { ...base, action: "retry", failureClass: "provider" };
  }

  const type = facts.providerErrorType?.toLowerCase();
  const code = facts.providerErrorCode?.toLowerCase();
  const identities = new Set([code, type].filter((value): value is string => !!value));
  const message = facts.providerErrorDetail?.toLowerCase() ?? "";

  if (
    [
      "missing_api_key",
      "restricted_api_key",
      "suspended_api_key",
      "invalid_permission",
    ].some((value) => identities.has(value))
  ) {
    return { ...base, action: "block_integration", failureClass: "authentication" };
  }
  if (
    ["daily_quota_exceeded", "monthly_quota_exceeded", "email_above_quota"].some(
      (value) => identities.has(value),
    )
  ) {
    return { ...base, action: "block_integration", failureClass: "quota" };
  }
  if (identities.has("rate_limit_exceeded")) {
    return { ...base, action: "retry", failureClass: "rate_limit" };
  }
  if (
    identities.has("concurrent_idempotent_requests") ||
    identities.has("resource_locked")
  ) {
    return { ...base, action: "retry", failureClass: "provider" };
  }
  if (identities.has("invalid_idempotent_request")) {
    return { ...base, action: "fail_delivery", failureClass: "consistency" };
  }
  if (identities.has("invalid_idempotency_key")) {
    return { ...base, action: "fail_delivery", failureClass: "configuration" };
  }
  if (identities.has("application_error") || identities.has("service_unavailable")) {
    return { ...base, action: "retry", failureClass: "provider" };
  }
  if (facts.httpStatus !== undefined && facts.httpStatus >= 500) {
    return { ...base, action: "retry", failureClass: "provider" };
  }

  const isTemplateProblem =
    /\btemplate\b/.test(message) &&
    /(not found|does not exist|invalid|publish|draft|variable|required|missing)/.test(message);
  const isVariableProblem =
    /\bvariables?\b/.test(message) &&
    /(invalid|missing|required|type|provided|value)/.test(message);
  if (isTemplateProblem || isVariableProblem) {
    return { ...base, action: "block_binding", failureClass: "configuration" };
  }

  const isIntegrationProblem =
    /only send testing emails|verify a domain|domain is not verified|invalid [`']?from|sender address|reply[_ -]?to/.test(
      message,
    );
  if (isIntegrationProblem) {
    return {
      ...base,
      action: "block_integration",
      failureClass: "configuration",
    };
  }

  return {
    ...base,
    action: "fail_delivery",
    failureClass: "provider",
  };
}

export function createResendEmailProviderAdapter(
  options: ResendEmailProviderAdapterOptions = {},
): EmailProviderAdapter {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw inputError(
      "EMAIL_PROVIDER_TIMEOUT_INVALID",
      "The Resend request timeout must be greater than zero.",
      { provider: "resend" },
    );
  }

  return Object.freeze({
    provider: "resend",
    validateCredentialEnvelope,
    validateSendInput,
    classifyError: classifyResendError,
    async send(input: EmailProviderSendInput): Promise<EmailProviderSendResult> {
      const credential = validateCredentialEnvelope(input.credential);
      validateSendInput(input);
      validateIdempotencyKey(input.idempotencyKey);

      const body = {
        from: input.from,
        to: input.to,
        ...(input.replyTo === undefined ? {} : { reply_to: input.replyTo }),
        template: {
          id: input.templateRef,
          variables: input.variables,
        },
      };
      const secrets = sensitiveValues(input);
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetchImpl(RESEND_SEND_EMAIL_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const rawBody = await response.text();
        const parsedBody = parseJsonRecord(rawBody);
        const providerRequestId = requestIdFrom(response, parsedBody, secrets);
        const responseBodyRedacted = sanitizeProviderBody(rawBody, parsedBody, secrets);
        const responseHeadersRedacted = safeResponseHeaders(response, secrets);

        if (!response.ok) {
          const rawProviderErrorType = optionalString(parsedBody, "name", "type");
          const rawProviderErrorCode = optionalString(parsedBody, "code");
          const rawDetail =
            optionalString(parsedBody, "message") ??
            (rawBody.trim().length > 0 ? rawBody : response.statusText);
          const providerErrorType = sanitizeProviderText(
            rawProviderErrorType,
            secrets,
          );
          const providerErrorCode = sanitizeProviderText(
            rawProviderErrorCode,
            secrets,
          );
          const retryAfter = safeRetryAfter(
            response.headers.get("retry-after") ?? undefined,
            secrets,
          );
          throw new ResendEmailProviderError({
            kind: "http",
            httpStatus: response.status,
            ...(providerErrorType === undefined ? {} : { providerErrorType }),
            ...(providerErrorCode === undefined ? {} : { providerErrorCode }),
            ...(rawDetail.length === 0
              ? {}
              : { providerErrorDetail: sanitizeProviderText(rawDetail, secrets) }),
            ...(providerRequestId === undefined
              ? {}
              : { providerRequestId }),
            ...(retryAfter === undefined ? {} : { retryAfter }),
            ...(responseHeadersRedacted === undefined
              ? {}
              : { responseHeadersRedacted }),
            ...(responseBodyRedacted === undefined
              ? {}
              : { responseBodyRedacted }),
          });
        }

        const providerMessageId = safeProviderIdentifier(
          optionalString(parsedBody, "id"),
          secrets,
        );
        if (!providerMessageId) {
          throw new ResendEmailProviderError({
            kind: "protocol",
            httpStatus: response.status,
            providerErrorCode: "missing_or_invalid_email_id",
            providerErrorDetail:
              "Resend returned a successful response without a valid email ID.",
            ...(providerRequestId === undefined ? {} : { providerRequestId }),
            ...(responseHeadersRedacted === undefined
              ? {}
              : { responseHeadersRedacted }),
            ...(responseBodyRedacted === undefined
              ? {}
              : { responseBodyRedacted }),
          });
        }
        return {
          providerMessageId,
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
          httpStatus: response.status,
          ...(responseHeadersRedacted === undefined
            ? {}
            : { responseHeadersRedacted }),
          ...(responseBodyRedacted === undefined
            ? {}
            : { responseBodyRedacted }),
        };
      } catch (error) {
        if (error instanceof ResendEmailProviderError) throw error;
        if (timedOut) {
          throw new ResendEmailProviderError({
            kind: "timeout",
            providerErrorCode: "request_timeout",
            providerErrorDetail: "The Resend request timed out.",
          });
        }
        const detail =
          error instanceof Error
            ? sanitizeProviderText(error.message, secrets)
            : "The Resend transport request failed.";
        throw new ResendEmailProviderError({
          kind: "transport",
          providerErrorCode:
            error instanceof Error
              ? sanitizeProviderText(error.name, secrets)
              : "transport_error",
          providerErrorDetail: detail ?? "The Resend transport request failed.",
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

export const resendEmailProviderAdapter = createResendEmailProviderAdapter();
