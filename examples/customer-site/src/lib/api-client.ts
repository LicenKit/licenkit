const API_BASE = "/api/v1";

interface SuccessEnvelope<T> { success: true; data: T }
interface ErrorPayload { code?: unknown; message?: unknown; details?: unknown; request_id?: unknown; requestId?: unknown }

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | null;
  readonly rawResponse: unknown;
  readonly method: string;
  readonly path: string;

  constructor(input: { code: string; message: string; status: number; details?: unknown; requestId?: string | null; rawResponse?: unknown; method: string; path: string }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.status = input.status;
    this.details = input.details;
    this.requestId = input.requestId ?? null;
    this.rawResponse = input.rawResponse;
    this.method = input.method;
    this.path = input.path;
  }
}

export function isApiError(value: unknown): value is ApiError { return value instanceof ApiError; }

export function formatApiError(value: unknown): string {
  if (value instanceof ApiError) return `${value.code}: ${value.message}${value.requestId ? ` · ${value.requestId}` : ""}`;
  return value instanceof Error ? value.message : "发生未知错误";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    camelize(item),
  ]));
}

function customerCsrfToken(): string | null {
  for (const part of document.cookie.split(";").map((value) => value.trim()).filter(Boolean)) {
    const separator = part.indexOf("=");
    const name = decodeURIComponent(separator === -1 ? part : part.slice(0, separator));
    if (["__Host-licenkit-customer-csrf", "licenkit_customer_csrf", "customer_csrf_token", "customer_csrf"].includes(name)) {
      return decodeURIComponent(separator === -1 ? "" : part.slice(separator + 1)) || null;
    }
  }
  return null;
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = customerCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new ApiError({
      code: "NETWORK_REQUEST_FAILED",
      message: error instanceof Error ? error.message : "Network request failed",
      status: 0,
      details: error instanceof Error ? { originalName: error.name, originalMessage: error.message } : { originalValue: String(error) },
      rawResponse: error,
      method,
      path,
    });
  }
  const payload = parseJson(await response.text());
  if (!response.ok || !isRecord(payload) || payload.success !== true || !("data" in payload)) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error as ErrorPayload : undefined;
    throw new ApiError({
      code: typeof error?.code === "string" ? error.code : `HTTP_${response.status || 0}`,
      message: typeof error?.message === "string" ? error.message : response.statusText || "Request failed",
      status: response.status,
      details: error?.details,
      requestId: typeof error?.request_id === "string" ? error.request_id : typeof error?.requestId === "string" ? error.requestId : response.headers.get("x-request-id"),
      rawResponse: payload,
      method,
      path,
    });
  }
  return (camelize(payload) as SuccessEnvelope<T>).data;
}

export interface Customer {
  id: string;
  email: string;
  name?: string | null;
  status: "active" | "disabled";
}

export interface Activation {
  id: string;
  name?: string | null;
  platform?: string | null;
  status: "active" | "deactivated" | "revoked";
  lastValidatedAt?: string | null;
}

export interface CustomerLicense {
  id: string;
  productId: string;
  productName?: string;
  status: "active" | "suspended" | "revoked" | "expired";
  licenseModel: "perpetual" | "fixed_term" | "subscription";
  renewalMode: "none" | "manual" | "billing";
  expiresAt: string | null;
  updatesUntil: string | null;
}

export interface KeyRotationResponse {
  license: CustomerLicense;
  licenseKey: string;
  delivery: { id: string; status: string } | null;
}

interface ListResponse<T> { items: T[] }

export const api = {
  customer: {
    auth: {
      config: () => request<{ turnstileSiteKey: string }>("/customer/auth/config"),
      requestMagicLink: (body: { accountSlug: string; email: string; turnstileToken: string }) => request<{ accepted: true }>("/customer/auth/magic-link", { method: "POST", body }),
      consumeMagicLink: (body: { accountSlug: string; token: string }) => request<{ authenticated: true; expiresAt: string }>("/customer/auth/magic-link/consume", { method: "POST", body }),
      logout: () => request<{ loggedOut: true }>("/customer/auth/logout", { method: "POST" }),
    },
    me: () => request<Customer>("/customer/me"),
    licenses: {
      list: () => request<ListResponse<CustomerLicense>>("/customer/licenses"),
      activations: (id: string) => request<ListResponse<Activation>>(`/customer/licenses/${encodeURIComponent(id)}/activations`),
      deactivate: (licenseId: string, activationId: string) => request<Activation>(`/customer/licenses/${encodeURIComponent(licenseId)}/activations/${encodeURIComponent(activationId)}/deactivate`, { method: "POST" }),
      recoverKey: (id: string) => request<KeyRotationResponse>(`/customer/licenses/${encodeURIComponent(id)}/recover-key`, { method: "POST" }),
      securityReset: (id: string) => request<KeyRotationResponse>(`/customer/licenses/${encodeURIComponent(id)}/security-reset`, { method: "POST" }),
      portalSession: (id: string) => request<{ url: string; expiresAt: string }>(`/customer/licenses/${encodeURIComponent(id)}/subscription/portal-session`, { method: "POST" }),
    },
  },
};
