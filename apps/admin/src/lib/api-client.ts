import { getErrorMessage } from "./i18n";

const API_BASE = "/api/v1";

export type Identifier = string;
export type IsoDateTime = string;
export type Role = "owner" | "admin" | "member" | "viewer";
export type LicenseModel = "perpetual" | "fixed_term" | "subscription";
export type RenewalMode = "none" | "manual" | "billing";
export type CredentialMode = "opaque" | "signed";
export type BillingEnvironment = "sandbox" | "live";
export type ReleasePlatform = "macos" | "windows" | "linux";
export type ReleaseArch = "universal" | "arm64" | "x86_64";

export interface SuccessEnvelope<T> { success: true; data: T }
interface ErrorPayload { code?: unknown; message?: unknown; details?: unknown; request_id?: unknown }
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

function detailString(details: unknown, ...keys: string[]): string | null {
  if (!isRecord(details)) return null;
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function formatProviderCause(details: unknown): string | null {
  const providerDetail = detailString(details, "provider_error_detail", "providerErrorDetail");
  if (!providerDetail) return null;

  const provider = detailString(details, "provider");
  const operation = detailString(details, "operation");
  const httpStatus = detailString(details, "http_status", "httpStatus");
  const providerType = detailString(details, "provider_error_type", "providerErrorType");
  const providerCode = detailString(details, "provider_error_code", "providerErrorCode");
  const providerIdentity = [...new Set([providerType, providerCode].filter((value): value is string => Boolean(value)))].join("/");
  const context = [
    provider,
    operation,
    httpStatus ? `upstream HTTP ${httpStatus}` : null,
    providerIdentity || null,
  ].filter((value): value is string => Boolean(value));

  return context.length > 0 ? `${context.join(" · ")}: ${providerDetail}` : providerDetail;
}

export function formatApiError(value: unknown): string {
  if (value instanceof ApiError) {
    const request = value.requestId ? ` · ${value.requestId}` : "";
    const localizedMessage = getErrorMessage(value.code, value.message);
    const providerCause = formatProviderCause(value.details);
    const cause = providerCause && providerCause !== localizedMessage ? ` · ${providerCause}` : "";
    return `${value.code}: ${localizedMessage}${cause}${request}`;
  }
  return value instanceof Error ? value.message : "发生未知错误";
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text) as unknown } catch { return text }
}

function csrfToken(scope: "admin"): string | null {
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

interface RequestOptions extends Omit<RequestInit, "body"> { body?: unknown; scope?: "admin" | "public" }

async function requestEnvelope<T>(path: string, options: RequestOptions = {}): Promise<SuccessEnvelope<T>> {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers);
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  const scope = options.scope ?? "admin";
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
      credentials: options.credentials ?? (scope === "public" ? "omit" : "include"),
      body: options.body === undefined || options.body instanceof FormData ? options.body : JSON.stringify(snakeize(options.body)),
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
      requestId: typeof error?.request_id === "string" ? error.request_id : response.headers.get("x-request-id"),
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
function snakeCaseKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
export function snakeize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [snakeCaseKey(key), snakeize(item)]));
}
function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    camelize(item),
  ]));
}
export function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") result.set(snakeCaseKey(key), String(value));
  const query = result.toString();
  return query ? `?${query}` : "";
}

export interface Pagination { page: number; limit: number; total: number; totalPages: number }
export interface ListResponse<T> { items: T[]; pagination?: Pagination }
export interface SetupStatus { initialized: boolean }
export interface User { id: Identifier; name: string; email: string; createdAt?: IsoDateTime; updatedAt?: IsoDateTime }
export interface Instance {
  id: Identifier;
  name: string;
  customerSiteUrl: string;
  adminApiUrl: string;
  status: "active" | "suspended" | "archived";
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}
export type MembershipStatus = "active" | "disabled" | "removed";
export interface InstanceMembership {
  role: Role;
  status: MembershipStatus;
}
export interface InstanceMember extends InstanceMembership {
  instanceId: Identifier;
  userId: Identifier;
  user: User;
  joinedByInvitationId?: Identifier | null;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";
export interface InstanceInvitation {
  id: Identifier;
  instanceId: Identifier;
  email: string;
  role: Role;
  status: InvitationStatus;
  delivery?: DeliveryReference | null;
  expiresAt: IsoDateTime;
  acceptedAt?: IsoDateTime | null;
  revokedAt?: IsoDateTime | null;
  createdAt: IsoDateTime;
}
export interface AdminSession { user: User; instance: Instance; membership: InstanceMembership; expiresAt?: IsoDateTime }
export interface TrialConfiguration { enabled: boolean; durationSeconds?: number; features: string[] }
export interface ProductSigningKey {
  id: Identifier;
  algorithm: "Ed25519";
  publicKey: string;
  status: "active" | "retired" | "revoked";
}
export interface Product {
  id: Identifier; name: string; description?: string | null; status: "active" | "archived";
  trial?: TrialConfiguration; signingKey?: ProductSigningKey | null;
  validationIntervalSeconds: number;
  createdAt?: IsoDateTime; updatedAt?: IsoDateTime;
}
export interface ProductRelease {
  id: Identifier; productId: Identifier; version: string; platform: ReleasePlatform; arch: ReleaseArch; description?: string | null; downloadUrl?: string | null;
  artifactSha256: string; releasedAt: IsoDateTime; createdAt?: IsoDateTime;
}
export interface LicensePlan {
  id: Identifier; productId: Identifier; name: string; licenseModel: LicenseModel; credentialMode: CredentialMode;
  maxActivations: number; features: string[]; updateWindowSeconds: number | null; defaultTermSeconds?: number | null;
  offlineGraceSeconds: number; paymentGraceSeconds: number; revision: number; status: "active" | "archived";
  createdAt?: IsoDateTime; updatedAt?: IsoDateTime;
}
export interface LicenseTerms {
  licenseModel: LicenseModel; renewalMode: RenewalMode; credentialMode: CredentialMode; maxActivations: number; features: string[];
  updatesUntil: IsoDateTime | null; offlineGraceSeconds: number; paymentGraceSeconds: number;
  sourceLicensePlanId: Identifier; sourceLicensePlanRevision: number;
}
export type DeliveryStatus = "pending" | "processing" | "waiting_configuration" | "retry_scheduled" | "accepted" | "failed" | "expired" | "cancelled";
export interface DeliveryReference { id: Identifier; status: DeliveryStatus }
export interface License {
  id: Identifier; productId: Identifier; productName?: string; customerId: Identifier; customerEmail?: string;
  licensePlanId?: Identifier; licensePlanName?: string; planRevision?: number;
  status: "active" | "suspended" | "revoked" | "expired"; statusReason?: string | null; licenseModel: LicenseModel;
  renewalMode: RenewalMode; credentialMode?: CredentialMode; expiresAt: IsoDateTime | null; updatesUntil: IsoDateTime | null;
  billingEnvironment: BillingEnvironment;
  maxActivations?: number; activeActivations?: number; features?: string[]; offlineGraceSeconds?: number; paymentGraceSeconds?: number;
  isCheckoutVerification?: boolean; terms?: LicenseTerms;
  delivery?: DeliveryReference | null; createdAt?: IsoDateTime; updatedAt?: IsoDateTime;
}
export interface IssuedLicenseResponse { license: License & { licenseKey: string }; delivery: DeliveryReference | null }
export interface Activation {
  id: Identifier; licenseId?: Identifier; name?: string | null; platform?: string | null; status: "active" | "deactivated" | "revoked";
  activatedAt?: IsoDateTime; lastValidatedAt?: IsoDateTime | null; deactivatedAt?: IsoDateTime | null; revokedAt?: IsoDateTime | null;
}
export interface Customer { id: Identifier; email: string; name?: string | null; status: "active" | "disabled"; hasSandboxLicense?: boolean; hasLiveLicense?: boolean; createdAt?: IsoDateTime; updatedAt?: IsoDateTime }
export interface CustomerLicenseSummary {
  id: Identifier; productId: Identifier; productName: string; billingEnvironment: BillingEnvironment;
  status: License["status"]; licenseModel: LicenseModel; renewalMode: RenewalMode;
  expiresAt: IsoDateTime | null; updatesUntil: IsoDateTime | null; createdAt: IsoDateTime;
}
export interface CustomerDetail { customer: Customer; licenses: CustomerLicenseSummary[] }
export interface ErrorSnapshot { code?: string | null; message?: string | null; details?: unknown; provider?: string | null; externalEventId?: string | null; httpStatus?: number | null; requestId?: string | null }
export type ReadinessState = "ready" | "not_ready" | "stale";
export interface ReadinessCheck { key: string; label?: string; status: ReadinessState; checkedAt?: IsoDateTime | null; lastSucceededAt?: IsoDateTime | null; error?: ErrorSnapshot | null; action?: string | null }
export interface ReadinessReport { checkoutAvailable: boolean; checks: ReadinessCheck[] }
export interface ProviderTestResult {
  providerId: Identifier;
  provider: "paddle";
  environment: BillingEnvironment;
  clientSideTokenValid: boolean;
  webhookSecretDecryptable: boolean;
  webhookVerifiedAt: IsoDateTime | null;
  simulatorTestCompletedAt: IsoDateTime | null;
  requiredEventTypes: string[];
  verifiedEventTypes: string[];
  missingEventTypes: string[];
  apiKeyConfigured: boolean;
  apiKeyCustomerRead: {
    status: "ok" | "error" | "not_configured";
    operation: "customers.list";
    errorCode: string | null;
    providerCode: string | null;
    httpStatus: number | null;
    requestId: string | null;
    retryAfter: string | null;
    message: string | null;
  };
}
export interface BillingProvider {
  id: Identifier; provider: "paddle"; environment: BillingEnvironment; status: "active" | "disabled" | "configuration_error";
  clientSideToken?: string; clientSideTokenConfigured?: boolean; webhookSecretConfigured: boolean; apiKeyConfigured: boolean;
  webhookVerifiedAt?: IsoDateTime | null; simulatorTestCompletedAt?: IsoDateTime | null;
  requiredEventTypes?: string[]; verifiedEventTypes?: string[]; missingEventTypes?: string[];
  apiCapabilities?: string[]; updatedAt?: IsoDateTime; readiness?: ReadinessReport;
}
export interface BillingOffer {
  id: Identifier; billingProviderId: Identifier; externalPriceId: string; productId: Identifier; productName?: string;
  licensePlanId: Identifier; licensePlanName?: string; purchaseType: "one_time" | "subscription";
  status: "draft" | "active" | "archived"; readiness?: ReadinessReport; createdAt?: IsoDateTime;
}
export interface BillingTestCheckoutConfig {
  checkout: {
    provider: "paddle";
    environment: "sandbox";
    clientSideToken: string;
    priceId: string;
    quantity: 1;
  };
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
export interface WebhookRejection {
  id: Identifier; billingProviderId: Identifier; provider: "paddle"; environment: BillingEnvironment;
  requestId: string; errorCode: string; httpStatus: number; webhookSecretVersion: number;
  payloadHash: string | null; receivedAt: IsoDateTime; status: "rejected";
}
export interface SystemIssue {
  id: Identifier;
  category: "billing" | "webhook" | "email";
  sourceType: string;
  sourceId: Identifier | string;
  operation: string;
  errorCode: string;
  status: "pending" | "processed";
  occurrenceCount: number;
  firstSeenAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  processedAt?: IsoDateTime | null;
  processedByUserId?: Identifier | null;
  error: Record<string, unknown>;
}
export interface EmailDelivery {
  id: Identifier;
  recipientType: "customer" | "instance_invitation";
  customerId: Identifier | null;
  notificationType: string;
  contractVersion: number;
  recipientEmail: string;
  sendExpiresAt?: IsoDateTime | null;
  variablesExpiresAt?: IsoDateTime | null;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt?: IsoDateTime | null;
  providerMessageId?: string | null;
  lastError?: Record<string, unknown> | null;
  acceptedAt?: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface KeyRotationResponse { license: License; licenseKey: string; delivery: DeliveryReference | null }

export interface EmailVariableDescriptor {
  name: string;
  type: "string" | "number";
  required: boolean;
  sensitive: boolean;
  format?: "email" | "uri" | "date-time";
  enumValues?: Array<string | number>;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  description: string;
  example: string | number;
}

export interface EmailTemplateContract {
  notificationType: string;
  version: number;
  name: string;
  description: string;
  variables: EmailVariableDescriptor[];
}

export interface EmailProviderTemplateExample {
  provider: string;
  notificationType: string;
  contractVersion: number;
  fileName: string;
  subject: string;
  html: string;
  text: string;
  placeholderSyntax: string;
}

export interface EmailIntegration {
  id: Identifier;
  provider: string;
  name: string;
  defaultFromEmail: string;
  defaultFromName?: string | null;
  replyToEmail?: string | null;
  maxAutomaticAttempts: number;
  status: "active" | "disabled";
  credentialConfigured: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface EmailTemplateBinding {
  id: Identifier;
  emailIntegrationId: Identifier;
  notificationType: string;
  contractVersion: number;
  providerTemplateRef: string;
  status: "active" | "disabled";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface EmailConfigurationTestResult {
  provider: string;
  providerTemplateRef: string;
  recipientEmail: string;
  providerAccepted: boolean;
  providerMessageId?: string | null;
  providerRequestId?: string | null;
  httpStatus?: number | null;
  error?: Record<string, unknown> | null;
}

export interface EmailDefaultTemplateInstallationResult {
  provider: string;
  installedCount: number;
  skippedCount: number;
  totalCount: number;
  complete: boolean;
  items: Array<{
    notificationType: string;
    contractVersion: number;
    providerTemplateRef: string;
    outcome: "installed" | "already_bound";
  }>;
}

export interface AdminStats {
  totalProducts: number;
  totalLicenses: number;
  activeActivations: number;
  expiringSoon: number;
  pendingInboundEvents: number;
  pendingDeliveries: number;
  pendingSystemIssues: number;
}
export type TrialStatus = "active" | "expired" | "revoked";
export interface TrialClaim {
  id: Identifier;
  productId: Identifier;
  productName: string;
  status: TrialStatus;
  claimedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  lastValidatedAt: IsoDateTime | null;
  revokedAt: IsoDateTime | null;
}

export const api = {
  setup: {
    status: () => request<SetupStatus>("/setup/status", { scope: "public" }),
    verifyToken: (setupToken: string) => request<{ valid: true }>("/setup/verify-token", { method: "POST", body: { setupToken }, scope: "public" }),
    complete: (body: { setupToken: string; user: { name: string; email: string; password: string }; instance: { name: string; customerSiteUrl: string; adminApiUrl: string } }) => request<AdminSession>("/setup", {
      method: "POST",
      body: {
        setupToken: body.setupToken,
        user: body.user,
        instance: body.instance,
      },
      scope: "public",
      credentials: "include",
    }),
  },
  admin: {
    auth: {
      login: (body: { email: string; password: string }) => request<AdminSession>("/admin/auth/login", { method: "POST", body, scope: "public", credentials: "include" }),
      session: () => request<AdminSession>("/admin/auth/session", { scope: "admin" }),
      logout: () => request<{ loggedOut: true }>("/admin/auth/logout", { method: "POST", scope: "admin" }),
    },
    stats: {
      get: () => request<AdminStats>("/admin/stats", { scope: "admin" }),
    },
    trials: {
      list: (params: { productId?: string; status?: TrialStatus; page?: number; limit?: number } = {}) =>
        request<ListResponse<TrialClaim>>(`/admin/trials${queryString(params)}`, { scope: "admin" }),
    },
    instance: {
      get: () => request<Instance>("/admin/instance", { scope: "admin" }),
    },
    members: {
      list: () => request<ListResponse<InstanceMember>>("/admin/members", { scope: "admin" }),
      update: (userId: string, body: { role?: Role; status?: MembershipStatus }) => request<InstanceMember>(`/admin/members/${encodeURIComponent(userId)}`, { method: "PATCH", body, scope: "admin" }),
    },
    invitations: {
      list: () => request<ListResponse<InstanceInvitation>>("/admin/invitations", { scope: "admin" }),
      create: (body: { email: string; role: Role }) => request<InstanceInvitation>("/admin/invitations", { method: "POST", body, scope: "admin" }),
      revoke: (invitationId: string) => request<InstanceInvitation>(`/admin/invitations/${encodeURIComponent(invitationId)}/revoke`, { method: "POST", scope: "admin" }),
      resend: (invitationId: string) => request<InstanceInvitation>(`/admin/invitations/${encodeURIComponent(invitationId)}/resend`, { method: "POST", scope: "admin" }),
    },
    profile: {
      get: () => request<User>("/admin/profile", { scope: "admin" }),
      update: (name: string) => request<User>("/admin/profile", { method: "PATCH", body: { name }, scope: "admin" }),
      changePassword: (body: { currentPassword: string; newPassword: string }) => request<{ passwordChanged: true }>("/admin/profile/password", {
        method: "POST",
        body,
        scope: "admin",
      }),
    },
    products: {
      list: () => request<ListResponse<Product>>("/admin/products", { scope: "admin" }),
      get: (id: string) => request<Product>(`/admin/products/${encodeURIComponent(id)}`, { scope: "admin" }),
      create: (body: { name: string; description?: string | null; validationIntervalSeconds: number; trial?: TrialConfiguration }) => request<Product>("/admin/products", { method: "POST", body, scope: "admin" }),
      update: (id: string, body: {
        name?: string;
        description?: string | null;
        paymentGraceSeconds?: number;
        validationIntervalSeconds?: number;
        trial?: TrialConfiguration;
      }) => request<Product>(`/admin/products/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
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
        offlineGraceSeconds: number; paymentGraceSeconds?: number;
      }) => request<LicensePlan>("/admin/license-plans", { method: "POST", body, scope: "admin" }),
      update: (id: string, body: Partial<Omit<LicensePlan, "id" | "productId" | "revision" | "createdAt" | "updatedAt">>) => request<{ revision: number; affectsExistingLicenses: false }>(`/admin/license-plans/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
      archive: (id: string) => request<LicensePlan>(`/admin/license-plans/${encodeURIComponent(id)}/archive`, { method: "POST", scope: "admin" }),
    },
    licenses: {
      list: (params: { page?: number; limit?: number; productId?: string; customerEmail?: string; status?: string; query?: string } = {}) => request<ListResponse<License>>(`/admin/licenses${queryString(params)}`, { scope: "admin" }),
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
      get: (id: string) => request<CustomerDetail>(`/admin/customers/${encodeURIComponent(id)}`, { scope: "admin" }),
      update: (id: string, body: { email?: string; name?: string }) => request<Customer>(`/admin/customers/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
      disable: (id: string) => request<Customer>(`/admin/customers/${encodeURIComponent(id)}/disable`, { method: "POST", scope: "admin" }),
      enable: (id: string) => request<Customer>(`/admin/customers/${encodeURIComponent(id)}/enable`, { method: "POST", scope: "admin" }),
      revokeSessions: (id: string) => request<{ revoked: number }>(`/admin/customers/${encodeURIComponent(id)}/sessions/revoke`, { method: "POST", scope: "admin" }),
    },
    emailTemplateContracts: {
      list: () => request<ListResponse<EmailTemplateContract>>("/admin/email-template-contracts", { scope: "admin" }),
      example: (provider: string, notificationType: string, contractVersion: number) =>
        request<EmailProviderTemplateExample>(`/admin/email-template-contracts/${encodeURIComponent(notificationType)}/versions/${contractVersion}/examples/${encodeURIComponent(provider)}`, { scope: "admin" }),
    },
    emailIntegrations: {
      list: () => request<ListResponse<EmailIntegration>>("/admin/email-integrations", { scope: "admin" }),
      create: (body: {
        provider: string; name: string; apiKey: string; defaultFromEmail: string; defaultFromName?: string;
        replyToEmail?: string; maxAutomaticAttempts: number;
      }) => request<EmailIntegration>("/admin/email-integrations", { method: "POST", body, scope: "admin" }),
      update: (id: string, body: {
        name?: string; defaultFromEmail?: string; defaultFromName?: string | null;
        replyToEmail?: string | null; maxAutomaticAttempts?: number;
      }) => request<EmailIntegration>(`/admin/email-integrations/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
      rotateCredential: (id: string, apiKey: string) => request<{ id: Identifier; credentialConfigured: true }>(`/admin/email-integrations/${encodeURIComponent(id)}/rotate-credential`, { method: "POST", body: { apiKey }, scope: "admin" }),
      disable: (id: string) => request<{ id: Identifier; status: "disabled" }>(`/admin/email-integrations/${encodeURIComponent(id)}/disable`, { method: "POST", scope: "admin" }),
      enable: (id: string) => request<{ id: Identifier; status: "active" }>(`/admin/email-integrations/${encodeURIComponent(id)}/enable`, { method: "POST", scope: "admin" }),
      installDefaultTemplates: (
        id: string,
        fullAccessApiKey: string,
        target?: { notificationType: string; contractVersion: number },
      ) =>
        request<EmailDefaultTemplateInstallationResult>(`/admin/email-integrations/${encodeURIComponent(id)}/template-bindings/install-defaults`, {
          method: "POST",
          body: { fullAccessApiKey, ...target },
          scope: "admin",
        }),
      bindings: {
        list: (integrationId: string) => request<ListResponse<EmailTemplateBinding>>(`/admin/email-integrations/${encodeURIComponent(integrationId)}/template-bindings`, { scope: "admin" }),
        upsert: (integrationId: string, notificationType: string, body: { contractVersion: number; providerTemplateRef: string }) =>
          request<EmailTemplateBinding>(`/admin/email-integrations/${encodeURIComponent(integrationId)}/template-bindings/${encodeURIComponent(notificationType)}`, { method: "PUT", body, scope: "admin" }),
        disable: (integrationId: string, notificationType: string) => request<{ id: Identifier; status: "disabled" }>(`/admin/email-integrations/${encodeURIComponent(integrationId)}/template-bindings/${encodeURIComponent(notificationType)}/disable`, { method: "POST", scope: "admin" }),
        enable: (integrationId: string, notificationType: string) => request<{ id: Identifier; status: "active" }>(`/admin/email-integrations/${encodeURIComponent(integrationId)}/template-bindings/${encodeURIComponent(notificationType)}/enable`, { method: "POST", scope: "admin" }),
        test: (integrationId: string, notificationType: string, body: { recipientEmail: string }) =>
          request<EmailConfigurationTestResult>(`/admin/email-integrations/${encodeURIComponent(integrationId)}/template-bindings/${encodeURIComponent(notificationType)}/test`, { method: "POST", body, scope: "admin" }),
        retryWaiting: (integrationId: string, notificationType: string) =>
          request<{ queuedCount: number }>(`/admin/email-integrations/${encodeURIComponent(integrationId)}/template-bindings/${encodeURIComponent(notificationType)}/retry-waiting`, { method: "POST", scope: "admin" }),
      },
    },
    emailDeliveries: {
      list: (params: { status?: DeliveryStatus; query?: string; page?: number; limit?: number } | DeliveryStatus = {}) => {
        const queryParams = typeof params === "string" ? { status: params } : params;
        return request<ListResponse<EmailDelivery>>(`/admin/email-deliveries${queryString(queryParams)}`, { scope: "admin" });
      },
      get: (id: string) => request<EmailDelivery>(`/admin/email-deliveries/${encodeURIComponent(id)}`, { scope: "admin" }),
      retry: (id: string, confirmPossibleDuplicate = false) => request<EmailDelivery>(`/admin/email-deliveries/${encodeURIComponent(id)}/retry`, { method: "POST", body: { confirmPossibleDuplicate }, scope: "admin" }),
      cancel: (id: string) => request<EmailDelivery>(`/admin/email-deliveries/${encodeURIComponent(id)}/cancel`, { method: "POST", scope: "admin" }),
    },
    billing: {
      providers: {
        list: () => request<ListResponse<BillingProvider>>("/admin/billing/providers", { scope: "admin" }),
        create: (body: { provider: "paddle"; environment: BillingEnvironment; clientSideToken: string; webhookSecret: string; apiKey?: string }) => request<BillingProvider>("/admin/billing/providers", { method: "POST", body, scope: "admin" }),
        update: (id: string, body: { clientSideToken?: string; webhookSecret?: string; apiKey?: string | null; status?: "active" | "disabled" }) => request<BillingProvider>(`/admin/billing/providers/${encodeURIComponent(id)}`, { method: "PATCH", body, scope: "admin" }),
        test: (id: string) => request<ProviderTestResult>(`/admin/billing/providers/${encodeURIComponent(id)}/test`, { method: "POST", scope: "admin" }),
      },
      offers: {
        list: () => request<ListResponse<BillingOffer>>("/admin/billing/offers", { scope: "admin" }),
        create: (body: { billingProviderId: string; externalPriceId: string; productId: string; licensePlanId: string; purchaseType: "one_time" | "subscription" }) => request<BillingOffer>("/admin/billing/offers", { method: "POST", body, scope: "admin" }),
        testCheckoutConfig: (id: string) => requestEnvelope<BillingTestCheckoutConfig>(`/admin/billing/offers/${encodeURIComponent(id)}/test-checkout-config`, { scope: "admin" }),
        activate: (id: string) => request<BillingOffer>(`/admin/billing/offers/${encodeURIComponent(id)}/activate`, { method: "POST", scope: "admin" }),
        archive: (id: string) => request<BillingOffer>(`/admin/billing/offers/${encodeURIComponent(id)}/archive`, { method: "POST", scope: "admin" }),
      },
      subscriptions: { list: () => request<ListResponse<BillingSubscription>>("/admin/billing/subscriptions", { scope: "admin" }) },
      adjustments: {
        list: () => request<ListResponse<BillingAdjustment>>("/admin/billing/adjustments", { scope: "admin" }),
        resolve: (id: string, body: { action: "no_action" | "keep_suspended" | "reinstate" | "revoke" | "security_reset"; reason: string }) => request<BillingAdjustment>(`/admin/billing/adjustments/${encodeURIComponent(id)}/resolve`, { method: "POST", body, scope: "admin" }),
      },
      events: {
        list: (params?: { status?: string; limit?: number; offset?: number }) => request<ListResponse<InboundEvent>>(`/admin/billing/events${queryString(params ?? {})}`, { scope: "admin" }),
        get: (id: string) => request<InboundEvent>(`/admin/billing/events/${encodeURIComponent(id)}`, { scope: "admin" }),
        replay: (id: string) => request<InboundEvent>(`/admin/billing/events/${encodeURIComponent(id)}/replay`, { method: "POST", scope: "admin" }),
        rejections: {
          list: (params: { requestId?: string; limit?: number; offset?: number } = {}) =>
            request<ListResponse<WebhookRejection>>(`/admin/billing/events/rejections${queryString(params)}`, { scope: "admin" }),
        },
      },
    },
    system: {
      issues: {
        list: (params?: { status?: string }) => request<ListResponse<SystemIssue>>(`/admin/system/issues${queryString(params ?? {})}`, { scope: "admin" }),
        process: (id: string) => request<{ id: Identifier; status: "processed"; processedAt: IsoDateTime }>(`/admin/system/issues/${encodeURIComponent(id)}/process`, { method: "POST", scope: "admin" }),
      },
    },
  },
  invitations: {
    acceptCurrentSession: (token: string) => request<AdminSession>("/invitations/accept", { method: "POST", body: { token }, scope: "admin" }),
    acceptExistingUser: (body: { token: string; email: string; password: string }) => request<AdminSession>("/invitations/accept", {
      method: "POST",
      body: { token: body.token, existingUser: { email: body.email, password: body.password } },
      scope: "public",
      credentials: "include",
    }),
    acceptNewUser: (body: { token: string; name: string; password: string }) => request<AdminSession>("/invitations/accept", {
      method: "POST",
      body: { token: body.token, newUser: { name: body.name, password: body.password } },
      scope: "public",
      credentials: "include",
    }),
  },
};
