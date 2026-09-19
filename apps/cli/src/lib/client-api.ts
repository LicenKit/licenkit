export type CredentialMode = "opaque" | "signed";

export interface LicenseTerms {
  max_activations: number;
  features: string[];
  updates_until: string | number | null;
}

export interface ClientCredentialResponse {
  activation_id: string;
  machine_token: string;
  credential_mode: CredentialMode;
  signed_license_token: string | null;
  signed_license_token_expires_at?: string | number | null;
  signing_key_id?: string | null;
  license_expires_at: string | number | null;
  terms: LicenseTerms;
}

export type TransportErrorKind = "network" | "dns" | "tls" | "timeout" | "server";

export class ClientTransportError extends Error {
  constructor(
    public readonly kind: TransportErrorKind,
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
    public readonly serverCode?: string,
    public readonly details: Record<string, string> = {}
  ) {
    super(message);
    this.name = "ClientTransportError";
  }
}

export class ClientApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly details: Record<string, string> = {}
  ) {
    super(message);
    this.name = "ClientApiError";
  }
}

export class ClientContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientContractError";
  }
}

const SENSITIVE_KEY = /(token|secret|password|license[_-]?key|authorization)/i;

function safeDetailValue(key: string, value: unknown): string {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null) return "null";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  try {
    return JSON.stringify(value, (nestedKey, nestedValue) =>
      nestedKey && SENSITIVE_KEY.test(nestedKey) ? "[REDACTED]" : nestedValue
    );
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

function sanitizeDetails(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, detail]) => [key, safeDetailValue(key, detail)])
  );
}

function classifyFetchError(error: unknown): TransportErrorKind {
  const candidate = error as { name?: string; message?: string; cause?: { code?: string } };
  const code = candidate.cause?.code ?? "";
  const message = `${candidate.name ?? ""} ${candidate.message ?? ""}`.toLowerCase();
  if (candidate.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || message.includes("timeout")) return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("dns")) return "dns";
  if (code.startsWith("ERR_TLS") || message.includes("certificate") || message.includes("tls")) return "tls";
  return "network";
}

export async function requestClientApi<T>(
  serverUrl: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, "")}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "LicenKit-CLI/1.0",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new ClientTransportError(
      classifyFetchError(error),
      `Unable to reach LicenKit server at ${serverUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const requestIdHeader = response.headers.get("x-request-id") ?? undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status >= 500) {
      throw new ClientTransportError(
        "server",
        `LicenKit server returned a non-JSON ${response.status} response`,
        response.status,
        requestIdHeader
      );
    }
    throw new ClientContractError(`LicenKit server returned a non-JSON ${response.status} response`);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    if (response.status >= 500) {
      throw new ClientTransportError(
        "server",
        `LicenKit server returned an invalid ${response.status} response envelope`,
        response.status,
        requestIdHeader
      );
    }
    throw new ClientContractError("LicenKit response envelope must be a JSON object");
  }

  const envelope = body as {
    success?: unknown;
    data?: T;
    error?: { code?: unknown; message?: unknown; request_id?: unknown; details?: unknown };
  };
  const serverError = envelope.error;
  const requestId = typeof serverError?.request_id === "string" ? serverError.request_id : requestIdHeader;
  const serverCode = typeof serverError?.code === "string" ? serverError.code : undefined;
  const serverMessage = typeof serverError?.message === "string"
    ? serverError.message
    : `LicenKit server returned HTTP ${response.status}`;
  const details = sanitizeDetails(serverError?.details);

  if (response.status >= 500) {
    throw new ClientTransportError("server", serverMessage, response.status, requestId, serverCode, details);
  }

  if (!response.ok || envelope.success === false) {
    throw new ClientApiError(serverCode ?? `HTTP_${response.status}`, serverMessage, response.status, requestId, details);
  }

  if (envelope.success !== true || !("data" in envelope)) {
    throw new ClientContractError("LicenKit response does not match the V1 success envelope");
  }
  return envelope.data as T;
}

export interface ClientContext {
  serverUrl: string;
  accountId: string;
  productId: string;
  fingerprint: string;
  devicePlatform: string;
  releaseVersion: string;
  releasePlatform: string;
}

export interface ActivateParams extends ClientContext {
  licenseKey: string;
  name?: string;
}

export async function apiActivate(params: ActivateParams): Promise<ClientCredentialResponse> {
  return requestClientApi(params.serverUrl, "/api/v1/client/activate", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      product_id: params.productId,
      license_key: params.licenseKey,
      fingerprint: params.fingerprint,
      device_platform: params.devicePlatform,
      name: params.name,
      release_version: params.releaseVersion,
      release_platform: params.releasePlatform,
    }),
  });
}

export interface ValidateParams extends ClientContext {
  activationId: string;
  machineToken: string;
}

export async function apiValidate(params: ValidateParams): Promise<ClientCredentialResponse> {
  return requestClientApi(params.serverUrl, "/api/v1/client/validate", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      product_id: params.productId,
      activation_id: params.activationId,
      machine_token: params.machineToken,
      fingerprint: params.fingerprint,
      device_platform: params.devicePlatform,
      release_version: params.releaseVersion,
      release_platform: params.releasePlatform,
    }),
  });
}

export interface DeactivateParams {
  serverUrl: string;
  accountId: string;
  productId: string;
  activationId: string;
  machineToken: string;
  fingerprint: string;
}

export interface DeactivateResponse {
  activation_id: string;
  status: "deactivated";
}

export async function apiDeactivate(params: DeactivateParams): Promise<DeactivateResponse> {
  return requestClientApi(params.serverUrl, "/api/v1/client/deactivate", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      product_id: params.productId,
      activation_id: params.activationId,
      machine_token: params.machineToken,
      fingerprint: params.fingerprint,
    }),
  });
}
