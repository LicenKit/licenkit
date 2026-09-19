const API_BASE = `${(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "")}/api/v1`;

export type Identifier = string;
export type IsoDateTime = string;
export type Role = "owner" | "admin" | "member" | "viewer";
export type LicenseModel = "perpetual" | "fixed_term" | "subscription";
export type RenewalMode = "none" | "manual" | "billing";
export type CredentialMode = "opaque" | "signed";
export type BillingEnvironment = "sandbox" | "live";

export interface SuccessEnvelope<T> { success: true; data: T }
interface ErrorPayload { code?: unknown; message?: unknown; details?: unknown; request_id?: unknown; requestId?: unknown }
interface ErrorEnvelope { success?: false; error?: ErrorPayload }

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | null;
  readonly rawResponse: unknown;
  readonly method: string;
  readonly path: string;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string | null;
    rawResponse?: unknown;
    method: string;
    path: string;
  }) {
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

export function isApiError(value: unknown): value is ApiError { return value instanceof ApiError }

export function formatApiError(value: unknown): string {
  if (value instanceof ApiError) {
    const request = value.requestId ? ` · ${value.requestId}` : "";
    return `${value.code}: ${value.message}${request}`;
  }
  return value instanceof Error ? value.message : "发生未知错误";
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text) as unknown } catch { return text }
}

function csrfToken(scope: "admin" | "customer"): string | null {
  const cookies = document.cookie.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    const name = separator === -1 ? part : part.slice(0, separator);
    const value = separator === -1 ? "" : part.slice(separator + 1);
    return [decodeURIComponent(name), decodeURIComponent(value)] as const;
  });
  const preferred = [`__Host-licenkit-${scope}-csrf`, `licenkit_${scope}_csrf`, `${scope}_csrf_token`, `${scope}_csrf`, "licenkit_csrf", "csrf_token"];
  for (const name of preferred) {
    const match = cookies.find(([cookieName]) => cookieName === name);
    if (match?.[1]) return match[1];
  }
  const scopedFallback = cookies.find(([name]) => name.includes(scope) && name.toLowerCase().includes("csrf"));
  if (scopedFallback?.[1]) return scopedFallback[1];
  return cookies.find(([name]) => name.toLowerCase().includes("csrf"))?.[1] ?? null;
}

interface RequestOptions extends Omit<RequestInit, "body"> { body?: unknown; scope?: "admin" | "customer" | "public" }

async function requestEnvelope<T>(path: string, options: RequestOptions = {}): Promise<SuccessEnvelope<T>> {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers);
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  const scope = options.scope ?? (path.startsWith("/customer/") ? "customer" : "admin");
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (mutating && scope !== "public") {
    const token = csrfToken(scope);
    if (token) headers.set("X-CSRF-Token", token);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      method,
      headers,
      credentials: scope === "public" ? "omit" : "include",
      body: options.body === undefined || options.body instanceof FormData ? options.body : JSON.stringify(options.body),
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
  if (!response.ok || !isSuccessEnvelope<T>(payload)) {
    const error = isRecord(payload) && isRecord(payload.error) ? (payload as ErrorEnvelope).error : undefined;
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
  return camelize(payload) as SuccessEnvelope<T>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await requestEnvelope<T>(path, options)).data;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function isSuccessEnvelope<T>(value: unknown): value is SuccessEnvelope<T> { return isRecord(value) && value.success === true && "data" in value }
function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    camelize(item),
  ]));
}
function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") result.set(key, String(value));
  const query = result.toString();
  return query ? `?${query}` : "";
}

export interface Pagination { page: number; limit: number; total: number; totalPages: number }
export interface ListResponse<T> { items: T[]; pagination?: Pagination }
export interface SetupStatus { initialized: boolean; instanceName?: string; version?: string }
export interface AdminUser { id: Identifier; name: string; email: string; role: Role; status?: "active" | "disabled"; createdAt?: IsoDateTime }
export interface Account { id: Identifier; slug: string; name: string; defaultSubscriptionPaymentGraceSeconds?: number; createdAt?: IsoDateTime }
export interface AdminSession { user: AdminUser; account: Account; expiresAt?: IsoDateTime }
export interface SetupResult { account: Pick<Account, "id" | "slug" | "name">; owner: AdminUser }
export interface TrialConfiguration { enabled: boolean; durationSeconds?: number; features: string[] }
export interface Product {
  id: Identifier; slug: string; name: string; description?: string | null; status: "active" | "archived";
  billingEnvironment: BillingEnvironment | null; trial?: TrialConfiguration; createdAt?: IsoDateTime; updatedAt?: IsoDateTime;
}
export interface ProductRelease {
  id: Identifier; productId: Identifier; version: string; platform: string; description?: string | null; downloadUrl?: string | null;
  artifactSha256: string; releasedAt: IsoDateTime; createdAt?: IsoDateTime;
}
export interface LicensePlan {
  id: Identifier; productId: Identifier; name: string; licenseModel: LicenseModel; credentialMode: CredentialMode;
  maxActivations: number; features: string[]; updateWindowSeconds: number | null; defaultTermSeconds?: number | null;
  signedTokenTtlSeconds: number; paymentGraceSeconds: number; revision: number; status: "active" | "archived";
  createdAt?: IsoDateTime; updatedAt?: IsoDateTime;
}
export interface LicenseTerms {
  licenseModel: LicenseModel; renewalMode: RenewalMode; credentialMode: CredentialMode; maxActivations: number; features: string[];
  updatesUntil: IsoDateTime | null; signedTokenTtlSeconds: number; paymentGraceSeconds: number;
  sourceLicensePlanId: Identifier; sourceLicensePlanRevision: number;
}
export type DeliveryStatus = "blocked_configuration" | "pending" | "processing" | "accepted" | "failed" | "payload_expired";
export interface DeliveryReference { id: Identifier; status: DeliveryStatus }
export interface License {
  id: Identifier; productId: Identifier; productName?: string; customerId: Identifier; customerEmail?: string;
  licensePlanId?: Identifier; licensePlanName?: string; planRevision?: number;
  status: "active" | "suspended" | "revoked" | "expired"; statusReason?: string | null; licenseModel: LicenseModel;
  renewalMode: RenewalMode; credentialMode?: CredentialMode; expiresAt: IsoDateTime | null; updatesUntil: IsoDateTime | null;
  maxActivations?: number; activeActivations?: number; features?: string[]; signedTokenTtlSeconds?: number; paymentGraceSeconds?: number;
  isCheckoutVerification?: boolean; terms?: LicenseTerms;
  delivery?: DeliveryReference | null; createdAt?: IsoDateTime; updatedAt?: IsoDateTime;
}
export interface IssuedLicenseResponse { license: License & { licenseKey: string }; delivery: DeliveryReference | null }
export interface Activation {
  id: Identifier; licenseId?: Identifier; name?: string | null; platform?: string | null; status: "active" | "deactivated" | "revoked";
  activatedAt?: IsoDateTime; lastValidatedAt?: IsoDateTime | null; deactivatedAt?: IsoDateTime | null; revokedAt?: IsoDateTime | null;
}
export interface Customer { id: Identifier; email: string; name?: string | null; status: "active" | "disabled"; createdAt?: IsoDateTime; updatedAt?: IsoDateTime }
export interface ErrorSnapshot { code?: string | null; message?: string | null; details?: unknown; provider?: string | null; externalEventId?: string | null; httpStatus?: number | null; requestId?: string | null }
export type ReadinessState = "ready" | "not_ready" | "stale";
export interface ReadinessCheck { key: string; label?: string; status: ReadinessState; checkedAt?: IsoDateTime | null; lastSucceededAt?: IsoDateTime | null; error?: ErrorSnapshot | null; action?: string | null }
export interface ReadinessReport { checkoutAvailable: boolean; checks: ReadinessCheck[] }
export interface ProviderTestResult {
  provider: "paddle";
  environment: BillingEnvironment;
  clientSideTokenValid: boolean;
  webhookSecretDecryptable: boolean;
  signatureSampleVerified: boolean | null;
  apiKeyConfigured: boolean;
}
export interface BillingProvider {
  id: Identifier; provider: "paddle"; environment: BillingEnvironment; status: "active" | "disabled" | "configuration_error";
  clientSideToken?: string; clientSideTokenConfigured?: boolean; webhookSecretConfigured: boolean; apiKeyConfigured: boolean;
  apiCapabilities?: string[]; updatedAt?: IsoDateTime; readiness?: ReadinessReport;
}
export interface BillingOffer {
  id: Identifier; billingProviderId: Identifier; externalPriceId: string; productId: Identifier; productName?: string;
  licensePlanId: Identifier; licensePlanName?: string; purchaseType: "one_time" | "subscription";
  status: "draft" | "active" | "archived"; readiness?: ReadinessReport; createdAt?: IsoDateTime;
}
export interface BillingVerificationConfig {
  verificationMode: true;
  verificationToken: string;
  expiresAt: IsoDateTime;
  product: { slug: string; name: string; description?: string };
  checkout: { available: true; provider: "paddle"; environment: "sandbox"; clientSideToken: string };
  offers: Array<{ id: string; name: string; purchaseType: "one_time" | "subscription"; priceId: string; quantity: 1 }>;
}
export interface BillingSubscription {
  id: Identifier; provider: "paddle"; environment: BillingEnvironment; externalSubscriptionId: string; licenseId: Identifier;
  customerId: Identifier; status: string; currentPeriodEnd?: IsoDateTime | null; cancelAtPeriodEnd?: boolean;
  trialEndsAt?: IsoDateTime | null; updatedAt?: IsoDateTime;
}
export interface BillingAdjustment {
  id: Identifier; provider: "paddle"; externalAdjustmentId: string; externalTransactionId?: string | null;
  externalSubscriptionId?: string | null; externalCustomerId?: string | null; action: string; type: string; status: string;
  amount?: string | null; currencyCode?: string | null; licenseId?: Identifier | null; automaticEffect?: string | null;
  reviewStatus: "open" | "resolved" | "processed"; reason?: string | null; updatedAt?: IsoDateTime;
}
export interface InboundEvent {
  id: Identifier; billingProviderId: Identifier; provider: "paddle"; environment: BillingEnvironment; externalEventId: string;
  eventType: string; status: "pending" | "processing" | "processed" | "needs_attention" | "failed";
  externalCustomerId?: string | null; externalTransactionId?: string | null; externalSubscriptionId?: string | null;
  externalAdjustmentId?: string | null; lastError?: ErrorSnapshot | null; lastErrorCode?: string | null; lastErrorDetail?: unknown;
  receivedAt: IsoDateTime; processedAt?: IsoDateTime | null;
}
export interface DeliveryAttempt { id: Identifier; source: "initial" | "automatic_retry" | "manual_retry"; sequence: number; httpStatus?: number | null; error?: ErrorSnapshot | null; attemptedAt: IsoDateTime }
export interface OutboundDelivery {
  id: Identifier; type: string; recipient?: { email?: string } | null; status: DeliveryStatus; endpointId?: Identifier | null;
  attemptCount?: number; automaticAttemptCount: number; maxAutomaticAttempts: number; payloadExpiresAt?: IsoDateTime | null;
  lastError?: ErrorSnapshot | null; lastErrorCode?: string | null; lastErrorDetail?: unknown;
  attempts?: DeliveryAttempt[]; createdAt: IsoDateTime; acceptedAt?: IsoDateTime | null;
}
export interface OutboundEndpoint {
  id: Identifier; endpointType: "notification_gateway" | "event_subscriber"; name?: string; url: string; subscribedEvents: string[];
  status: "active" | "disabled"; timeoutMs: number; maxAutomaticAttempts: number; lastTestStatus?: "accepted" | "failed" | null;
  lastTestedAt?: IsoDateTime | null; createdAt?: IsoDateTime;
}
export interface CustomerLicense extends Omit<License, "customerId" | "customerEmail"> { features?: string[]; subscription?: BillingSubscription | null; activations?: Activation[] }
export interface KeyRotationResponse { license: License; licenseKey: string; delivery: DeliveryReference | null }

interface OutboundDeliveryTransport extends Omit<OutboundDelivery, "type" | "recipient" | "attempts"> {
  eventType?: string;
  recipientEmail?: string | null;
}

interface DeliveryAttemptTransport {
  id: string;
  attemptNumber: number;
  attemptSource: "initial" | "automatic_retry" | "manual_retry";
  outcome?: string | null;
  httpStatus?: number | null;
  responseBodyRedacted?: string | null;
  transportErrorCode?: string | null;
  transportErrorDetail?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

function normalizeDelivery(delivery: OutboundDeliveryTransport, attempts?: DeliveryAttemptTransport[]): OutboundDelivery {
  return {
    ...delivery,
    type: delivery.eventType || "unknown",
    recipient: delivery.recipientEmail ? { email: delivery.recipientEmail } : null,
    lastError: delivery.lastError ?? (delivery.lastErrorCode || delivery.lastErrorDetail ? {
      code: delivery.lastErrorCode,
      details: delivery.lastErrorDetail,
    } : null),
    attempts: attempts?.map((attempt) => ({
      id: attempt.id,
      source: attempt.attemptSource,
      sequence: attempt.attemptNumber,
      httpStatus: attempt.httpStatus,
      attemptedAt: attempt.startedAt,
      error: attempt.transportErrorCode || attempt.transportErrorDetail || attempt.responseBodyRedacted ? {
        code: attempt.transportErrorCode,
        message: attempt.transportErrorDetail,
        details: { outcome: attempt.outcome, responseBodyRedacted: attempt.responseBodyRedacted },
      } : null,
    })),
  };
}

export const api = {
  setup: {
    status: () => request<SetupStatus>("/setup/status", { scope: "public" }),
    complete: (body: { setupToken: string; instanceName: string; accountSlug: string; owner: { name: string; email: string; password: string } }) => request<SetupResult>("/setup", { method: "POST", body, scope: "admin" }),
  },
  admin: {
    auth: {
      login: (body: { accountSlug: string; email: string; password: string }) => request<AdminSession>("/admin/auth/login", { method: "POST", body, scope: "admin" }),
      session: () => request<AdminSession>("/admin/auth/session", { scope: "admin" }),
      logout: () => request<{ loggedOut: true }>("/admin/auth/logout", { method: "POST", scope: "admin" }),
    },
    account: {
      get: () => request<Account>("/admin/account", { scope: "admin" }),
      update: (body: Partial<Pick<Account, "name" | "defaultSubscriptionPaymentGraceSeconds">>) => request<Account>("/admin/account", { method: "PATCH", body, scope: "admin" }),
    },
    users: {
      list: () => request<ListResponse<AdminUser>>("/admin/users", { scope: "admin" }),
      create: (body: { name: string; email: string; password: string; role: Exclude<Role, "owner"> }) => request<AdminUser>("/admin/users", { method: "POST", body, scope: "admin" }),
      update: (id: string, body: { name?: string; role?: Role; status?: "active" | "disabled"; password?: string }) => request<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
      revokeSessions: (id: string) => request<{ revoked: true }>(`/admin/users/${encodeURIComponent(id)}/sessions/revoke`, { method: "POST", scope: "admin" }),
    },
    products: {
      list: () => request<ListResponse<Product>>("/admin/products", { scope: "admin" }),
      get: (id: string) => request<Product>(`/admin/products/${encodeURIComponent(id)}`, { scope: "admin" }),
      create: (body: { slug: string; name: string; description?: string | null; billingEnvironment: BillingEnvironment | null; trial?: TrialConfiguration }) => request<Product>("/admin/products", { method: "POST", body, scope: "admin" }),
      update: (id: string, body: Partial<Omit<Product, "id" | "createdAt" | "updatedAt">>) => request<Product>(`/admin/products/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
      archive: (id: string) => request<Product>(`/admin/products/${encodeURIComponent(id)}/archive`, { method: "POST", scope: "admin" }),
      releases: {
        list: (productId: string) => request<ListResponse<ProductRelease>>(`/admin/products/${encodeURIComponent(productId)}/releases`, { scope: "admin" }),
        create: (productId: string, body: Omit<ProductRelease, "id" | "productId" | "createdAt">) => request<ProductRelease>(`/admin/products/${encodeURIComponent(productId)}/releases`, { method: "POST", body, scope: "admin" }),
        update: (productId: string, releaseId: string, body: Pick<ProductRelease, "description" | "downloadUrl">) => request<ProductRelease>(`/admin/products/${encodeURIComponent(productId)}/releases/${encodeURIComponent(releaseId)}`, { method: "PATCH", body, scope: "admin" }),
      },
    },
    licensePlans: {
      list: (productId?: string) => request<ListResponse<LicensePlan>>(`/admin/license-plans${queryString({ productId })}`, { scope: "admin" }),
      get: (id: string) => request<LicensePlan>(`/admin/license-plans/${encodeURIComponent(id)}`, { scope: "admin" }),
      create: (body: {
        productId: string; name: string; licenseModel: LicenseModel; credentialMode: CredentialMode; maxActivations: number;
        features: string[]; updateWindowSeconds: number | null; defaultTermSeconds?: number | null;
        signedTokenTtlSeconds: number; paymentGraceSeconds?: number;
      }) => request<LicensePlan>("/admin/license-plans", { method: "POST", body, scope: "admin" }),
      update: (id: string, body: Partial<Omit<LicensePlan, "id" | "productId" | "revision" | "createdAt" | "updatedAt">>) => request<{ revision: number; affectsExistingLicenses: false }>(`/admin/license-plans/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
      archive: (id: string) => request<LicensePlan>(`/admin/license-plans/${encodeURIComponent(id)}/archive`, { method: "POST", scope: "admin" }),
    },
    licenses: {
      list: (params: { page?: number; limit?: number; productId?: string; customerId?: string; status?: string; query?: string } = {}) => request<ListResponse<License>>(`/admin/licenses${queryString(params)}`, { scope: "admin" }),
      get: (id: string) => request<License>(`/admin/licenses/${encodeURIComponent(id)}`, { scope: "admin" }),
      issue: (body: { licensePlanId: string; customerEmail: string; expiresAt?: string | null; delivery: { sendNotification: true } }) => request<IssuedLicenseResponse>("/admin/licenses", { method: "POST", body, scope: "admin" }),
      suspend: (id: string, reason: string) => request<License>(`/admin/licenses/${encodeURIComponent(id)}/suspend`, { method: "POST", body: { reason }, scope: "admin" }),
      reinstate: (id: string, reason: string) => request<License>(`/admin/licenses/${encodeURIComponent(id)}/reinstate`, { method: "POST", body: { reason }, scope: "admin" }),
      revoke: (id: string, reason: string) => request<License>(`/admin/licenses/${encodeURIComponent(id)}/revoke`, { method: "POST", body: { reason }, scope: "admin" }),
      recoverKey: (id: string) => request<KeyRotationResponse>(`/admin/licenses/${encodeURIComponent(id)}/recover-key`, { method: "POST", scope: "admin" }),
      securityReset: (id: string) => request<KeyRotationResponse>(`/admin/licenses/${encodeURIComponent(id)}/security-reset`, { method: "POST", scope: "admin" }),
      extendUpdates: (id: string, updatesUntil: string | null, reason: string) => request<License>(`/admin/licenses/${encodeURIComponent(id)}/extend-updates`, { method: "POST", body: { updatesUntil, reason }, scope: "admin" }),
      renewTerm: (id: string, expiresAt: string, reason: string) => request<License>(`/admin/licenses/${encodeURIComponent(id)}/renew-term`, { method: "POST", body: { expiresAt, reason }, scope: "admin" }),
      activations: (id: string) => request<ListResponse<Activation>>(`/admin/licenses/${encodeURIComponent(id)}/activations`, { scope: "admin" }),
      revokeActivation: (licenseId: string, activationId: string, reason: string) => request<Activation>(`/admin/licenses/${encodeURIComponent(licenseId)}/activations/${encodeURIComponent(activationId)}/revoke`, { method: "POST", body: { reason }, scope: "admin" }),
    },
    customers: {
      list: (params: { page?: number; limit?: number; query?: string; status?: string } = {}) => request<ListResponse<Customer>>(`/admin/customers${queryString(params)}`, { scope: "admin" }),
      get: (id: string) => request<Customer>(`/admin/customers/${encodeURIComponent(id)}`, { scope: "admin" }),
      update: (id: string, body: { email?: string; name?: string }) => request<Customer>(`/admin/customers/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
      disable: (id: string) => request<Customer>(`/admin/customers/${encodeURIComponent(id)}/disable`, { method: "POST", scope: "admin" }),
      enable: (id: string) => request<Customer>(`/admin/customers/${encodeURIComponent(id)}/enable`, { method: "POST", scope: "admin" }),
      revokeSessions: (id: string) => request<{ revoked: number }>(`/admin/customers/${encodeURIComponent(id)}/sessions/revoke`, { method: "POST", scope: "admin" }),
    },
    billing: {
      providers: {
        list: () => request<ListResponse<BillingProvider>>("/admin/billing/providers", { scope: "admin" }),
        create: (body: { provider: "paddle"; environment: BillingEnvironment; clientSideToken: string; webhookSecret: string; apiKey?: string; status?: "active" | "disabled" }) => request<BillingProvider>("/admin/billing/providers", { method: "POST", body, scope: "admin" }),
        update: (id: string, body: { clientSideToken?: string; webhookSecret?: string; apiKey?: string | null; status?: "active" | "disabled" }) => request<BillingProvider>(`/admin/billing/providers/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
        test: (id: string) => request<ProviderTestResult>(`/admin/billing/providers/${encodeURIComponent(id)}/test`, { method: "POST", scope: "admin" }),
      },
      offers: {
        list: () => request<ListResponse<BillingOffer>>("/admin/billing/offers", { scope: "admin" }),
        create: (body: { billingProviderId: string; externalPriceId: string; productId: string; licensePlanId: string; purchaseType: "one_time" | "subscription" }) => request<BillingOffer>("/admin/billing/offers", { method: "POST", body, scope: "admin" }),
        verificationConfig: (id: string) => requestEnvelope<BillingVerificationConfig>(`/admin/billing/offers/${encodeURIComponent(id)}/verification-config`, { method: "POST", scope: "admin" }),
        activate: (id: string) => request<BillingOffer>(`/admin/billing/offers/${encodeURIComponent(id)}/activate`, { method: "POST", scope: "admin" }),
        archive: (id: string) => request<BillingOffer>(`/admin/billing/offers/${encodeURIComponent(id)}/archive`, { method: "POST", scope: "admin" }),
      },
      subscriptions: { list: () => request<ListResponse<BillingSubscription>>("/admin/billing/subscriptions", { scope: "admin" }) },
      adjustments: {
        list: () => request<ListResponse<BillingAdjustment>>("/admin/billing/adjustments", { scope: "admin" }),
        resolve: (id: string, body: { action: "no_action" | "keep_suspended" | "reinstate" | "revoke" | "security_reset"; reason: string }) => request<BillingAdjustment>(`/admin/billing/adjustments/${encodeURIComponent(id)}/resolve`, { method: "POST", body, scope: "admin" }),
      },
      events: {
        list: () => request<ListResponse<InboundEvent>>("/admin/billing/events", { scope: "admin" }),
        get: (id: string) => request<InboundEvent>(`/admin/billing/events/${encodeURIComponent(id)}`, { scope: "admin" }),
        replay: (id: string) => request<InboundEvent>(`/admin/billing/events/${encodeURIComponent(id)}/replay`, { method: "POST", scope: "admin" }),
      },
    },
    outbound: {
      endpoints: {
        list: () => request<ListResponse<OutboundEndpoint>>("/admin/outbound/endpoints", { scope: "admin" }),
        create: (body: { endpointType: "notification_gateway" | "event_subscriber"; name: string; url: string; subscribedEvents: string[]; timeoutMs: number; maxAutomaticAttempts: number }) => request<OutboundEndpoint & { signingSecret?: string }>("/admin/outbound/endpoints", { method: "POST", body, scope: "admin" }),
        test: (id: string) => request<{ status: "accepted" | "failed"; error?: ErrorSnapshot }>(`/admin/outbound/endpoints/${encodeURIComponent(id)}/test`, { method: "POST", scope: "admin" }),
        disable: (id: string) => request<OutboundEndpoint>(`/admin/outbound/endpoints/${encodeURIComponent(id)}/disable`, { method: "POST", scope: "admin" }),
      },
      deliveries: {
        list: async () => {
          const result = await request<ListResponse<OutboundDeliveryTransport>>("/admin/outbound/deliveries", { scope: "admin" });
          return { ...result, items: result.items.map((item) => normalizeDelivery(item)) };
        },
        get: async (id: string) => {
          const result = await request<{ delivery: OutboundDeliveryTransport; attempts: DeliveryAttemptTransport[] }>(`/admin/outbound/deliveries/${encodeURIComponent(id)}`, { scope: "admin" });
          return normalizeDelivery(result.delivery, result.attempts);
        },
        retry: (id: string) => request<OutboundDelivery>(`/admin/outbound/deliveries/${encodeURIComponent(id)}/retry`, { method: "POST", scope: "admin" }),
        resume: (id: string) => request<OutboundDelivery>(`/admin/outbound/deliveries/${encodeURIComponent(id)}/resume-after-configuration`, { method: "POST", scope: "admin" }),
      },
    },
  },
  customer: {
    auth: {
      requestMagicLink: (body: { accountSlug: string; email: string }) => request<{ accepted: true }>("/customer/auth/magic-link", { method: "POST", body, scope: "customer" }),
      consumeMagicLink: (body: { accountSlug: string; token: string }) => request<{ authenticated: true; expiresAt: string }>("/customer/auth/magic-link/consume", { method: "POST", body, scope: "customer" }),
      logout: () => request<{ loggedOut: true }>("/customer/auth/logout", { method: "POST", scope: "customer" }),
    },
    me: () => request<Customer>("/customer/me", { scope: "customer" }),
    licenses: {
      list: () => request<ListResponse<CustomerLicense>>("/customer/licenses", { scope: "customer" }),
      get: (id: string) => request<CustomerLicense>(`/customer/licenses/${encodeURIComponent(id)}`, { scope: "customer" }),
      activations: (id: string) => request<ListResponse<Activation>>(`/customer/licenses/${encodeURIComponent(id)}/activations`, { scope: "customer" }),
      subscription: (id: string) => request<{ renewalMode: RenewalMode; billingSubscription: BillingSubscription | null; expiresAt: string | null }>(`/customer/licenses/${encodeURIComponent(id)}/subscription`, { scope: "customer" }),
      deactivate: (licenseId: string, activationId: string) => request<Activation>(`/customer/licenses/${encodeURIComponent(licenseId)}/activations/${encodeURIComponent(activationId)}/deactivate`, { method: "POST", scope: "customer" }),
      recoverKey: (id: string) => request<KeyRotationResponse>(`/customer/licenses/${encodeURIComponent(id)}/recover-key`, { method: "POST", scope: "customer" }),
      securityReset: (id: string) => request<KeyRotationResponse>(`/customer/licenses/${encodeURIComponent(id)}/security-reset`, { method: "POST", scope: "customer" }),
      portalSession: (id: string) => request<{ url: string; expiresAt: string }>(`/customer/licenses/${encodeURIComponent(id)}/subscription/portal-session`, { method: "POST", scope: "customer" }),
    },
  },
};
