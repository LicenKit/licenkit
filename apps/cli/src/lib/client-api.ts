export type CredentialMode = "opaque" | "signed";

export const DEFAULT_VALIDATION_INTERVAL_SECONDS = 3600;
export const MIN_VALIDATION_INTERVAL_SECONDS = 3600;
export const MAX_VALIDATION_INTERVAL_SECONDS = 86400;

export function effectiveValidationIntervalSeconds(received: number | null): number {
  const candidate = received ?? DEFAULT_VALIDATION_INTERVAL_SECONDS;
  return Math.min(MAX_VALIDATION_INTERVAL_SECONDS, Math.max(MIN_VALIDATION_INTERVAL_SECONDS, candidate));
}

export interface LicenseTerms {
  max_activations: number;
  features: string[];
  updates_until: string | null;
}

export interface ValidationMetadata {
  validation_interval_seconds: number | null;
  validated_at: string;
}

export interface ResponseMetadata {
  request_id: string;
}

export type TrialAvailability =
  | { status: "available"; duration_seconds: number; features: string[] }
  | {
      status: "unavailable";
      reason: "not_enabled" | "already_claimed";
      code: "TRIAL_NOT_ENABLED" | "TRIAL_ALREADY_CLAIMED";
      details: Record<string, string>;
    };

export interface ActivationRequiredState {
  kind: "activation_required";
  trial: TrialAvailability;
}

export type TrialState =
  | { kind: "trial"; status: "active"; expires_at: string; features: string[] }
  | {
      kind: "trial";
      status: "expired";
      code: "TRIAL_EXPIRED";
      expires_at: string | null;
      details: Record<string, string>;
    }
  | {
      kind: "trial";
      status: "revoked";
      code: "TRIAL_REVOKED";
      reason: string | null;
      details: Record<string, string>;
    };

export interface ActiveLicenseState {
  kind: "license";
  status: "active";
  expires_at: string | null;
  terms: LicenseTerms;
}

export type LicenseState =
  | ActiveLicenseState
  | {
      kind: "license";
      status: "expired";
      code: "LICENSE_EXPIRED";
      expires_at: string | null;
      details: Record<string, string>;
    }
  | {
      kind: "license";
      status: "suspended";
      code: "LICENSE_SUSPENDED";
      reason: string | null;
      details: Record<string, string>;
    }
  | {
      kind: "license";
      status: "revoked";
      code: "LICENSE_REVOKED";
      reason: string | null;
      details: Record<string, string>;
    }
  | { kind: "license"; status: "activation_revoked"; code: "ACTIVATION_REVOKED"; details: Record<string, string> }
  | { kind: "license"; status: "activation_deactivated"; code: "ACTIVATION_DEACTIVATED"; details: Record<string, string> };

export type ReleaseNotEligibleState =
  {
      kind: "release_not_eligible";
      status: "update_required";
      code: "UPDATE_ENTITLEMENT_REQUIRED";
      release_version: string;
      release_platform: string;
      release_arch: string;
      updates_until: string;
      released_at: string;
      details: Record<string, string>;
    };

export type EntitlementState = ActivationRequiredState | TrialState | LicenseState | ReleaseNotEligibleState;

export interface CredentialUpdate {
  credential_mode: CredentialMode;
  signed_license_token: string | null;
  signed_license_token_expires_at: string | null;
  signing_key_id: string | null;
}

export interface ActivationResponse {
  activation_id: string;
  machine_token: string;
  credential_mode: CredentialMode;
  signed_license_token: string | null;
  signed_license_token_expires_at: string | null;
  signing_key_id: string | null;
  license_expires_at: string | null;
  terms: LicenseTerms;
  state: ActiveLicenseState;
  validation: ValidationMetadata;
  meta: ResponseMetadata;
}

export interface ValidateResponse {
  state: EntitlementState;
  credential_update?: CredentialUpdate;
  validation: ValidationMetadata;
  meta: ResponseMetadata;
}

export type TransportErrorKind = "network" | "dns" | "tls" | "timeout" | "server";

export class ClientTransportError extends Error {
  constructor(
    public readonly kind: TransportErrorKind,
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
    public readonly serverCode?: string,
    public readonly details: Record<string, string> = {},
    public readonly causeCode?: string
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
  constructor(
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
    public readonly details: Record<string, string> = {}
  ) {
    super(message);
    this.name = "ClientContractError";
  }
}

function contractObject(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientContractError(`${description} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function contractString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ClientContractError(`${description} must be a non-empty string`);
  return value;
}

function contractNullableString(value: unknown, description: string): string | null {
  if (value === null) return null;
  return contractString(value, description);
}

function contractDate(value: unknown, description: string): string {
  const date = contractString(value, description);
  if (!Number.isFinite(Date.parse(date))) throw new ClientContractError(`${description} must be an ISO-8601 timestamp`);
  return date;
}

function contractNullableDate(value: unknown, description: string): string | null {
  if (value === null) return null;
  return contractDate(value, description);
}

function contractFeatures(value: unknown, description: string): string[] {
  if (!Array.isArray(value) || value.some((feature) => typeof feature !== "string")) {
    throw new ClientContractError(`${description} must be an array of strings`);
  }
  return value;
}

function parseLicenseTerms(value: unknown): LicenseTerms {
  const terms = contractObject(value, "License terms");
  if (!Number.isSafeInteger(terms.max_activations) || Number(terms.max_activations) < 1) {
    throw new ClientContractError("License terms max_activations must be a positive integer");
  }
  return {
    max_activations: Number(terms.max_activations),
    features: contractFeatures(terms.features, "License terms features"),
    updates_until: contractNullableDate(terms.updates_until, "License terms updates_until"),
  };
}

function parseValidationMetadata(value: unknown): ValidationMetadata {
  const validation = contractObject(value, "Validation metadata");
  const interval = validation.validation_interval_seconds;
  if (interval !== null && (!Number.isSafeInteger(interval) || Number(interval) < 0)) {
    throw new ClientContractError("validation_interval_seconds must be null or a non-negative integer");
  }
  return {
    validation_interval_seconds: interval === null ? null : Number(interval),
    validated_at: contractDate(validation.validated_at, "validated_at"),
  };
}

function parseResponseMetadata(value: unknown): ResponseMetadata {
  const meta = contractObject(value, "Response metadata");
  return { request_id: contractString(meta.request_id, "request_id") };
}

function parseTrialAvailability(value: unknown): TrialAvailability {
  const trial = contractObject(value, "Trial availability");
  if (trial.status === "available") {
    if (!Number.isSafeInteger(trial.duration_seconds) || Number(trial.duration_seconds) <= 0) {
      throw new ClientContractError("Trial duration_seconds must be a positive integer");
    }
    return {
      status: "available",
      duration_seconds: Number(trial.duration_seconds),
      features: contractFeatures(trial.features, "Trial features"),
    };
  }
  const unavailable = {
    not_enabled: "TRIAL_NOT_ENABLED",
    already_claimed: "TRIAL_ALREADY_CLAIMED",
  } as const;
  if (trial.status !== "unavailable" || typeof trial.reason !== "string" || !(trial.reason in unavailable)) {
    throw new ClientContractError(`Unknown Trial availability '${String(trial.status)}'`);
  }
  const reason = trial.reason as keyof typeof unavailable;
  if (trial.code !== unavailable[reason]) {
    throw new ClientContractError(`Trial availability code does not match reason '${reason}'`);
  }
  return {
    status: "unavailable",
    reason,
    code: unavailable[reason],
    details: sanitizeDetails(trial.details),
  };
}

export function parseEntitlementState(value: unknown): EntitlementState {
  const state = contractObject(value, "Entitlement state");
  if (state.kind === "activation_required") {
    return { kind: "activation_required", trial: parseTrialAvailability(state.trial) };
  }
  if (state.kind === "trial") {
    if (state.status === "active") {
      return {
        kind: "trial",
        status: "active",
        expires_at: contractDate(state.expires_at, "Trial expires_at"),
        features: contractFeatures(state.features, "Trial features"),
      };
    }
    if (state.status === "expired" && state.code === "TRIAL_EXPIRED") {
      return {
        kind: "trial",
        status: "expired",
        code: state.code,
        expires_at: contractNullableDate(state.expires_at ?? null, "Trial expires_at"),
        details: sanitizeDetails(state.details),
      };
    }
    if (state.status === "revoked" && state.code === "TRIAL_REVOKED") {
      return {
        kind: "trial",
        status: "revoked",
        code: state.code,
        reason: contractNullableString(state.reason ?? null, "Trial revoke reason"),
        details: sanitizeDetails(state.details),
      };
    }
    throw new ClientContractError(`Unknown Trial state '${String(state.status)}'`);
  }
  if (state.kind === "license") {
    if (state.status === "active") {
      return {
        kind: "license",
        status: "active",
        expires_at: contractNullableDate(state.expires_at, "License expires_at"),
        terms: parseLicenseTerms(state.terms),
      };
    }
    if (state.status === "expired" && state.code === "LICENSE_EXPIRED") {
      return {
        kind: "license",
        status: "expired",
        code: state.code,
        expires_at: contractNullableDate(state.expires_at ?? null, "License expires_at"),
        details: sanitizeDetails(state.details),
      };
    }
    if (state.status === "suspended" && state.code === "LICENSE_SUSPENDED") {
      return {
        kind: "license",
        status: "suspended",
        code: state.code,
        reason: contractNullableString(state.reason ?? null, "License suspension reason"),
        details: sanitizeDetails(state.details),
      };
    }
    if (state.status === "revoked" && state.code === "LICENSE_REVOKED") {
      return {
        kind: "license",
        status: "revoked",
        code: state.code,
        reason: contractNullableString(state.reason ?? null, "License revoke reason"),
        details: sanitizeDetails(state.details),
      };
    }
    if (state.status === "activation_revoked" && state.code === "ACTIVATION_REVOKED") {
      return {
        kind: "license",
        status: "activation_revoked",
        code: state.code,
        details: sanitizeDetails(state.details),
      };
    }
    if (state.status === "activation_deactivated" && state.code === "ACTIVATION_DEACTIVATED") {
      return {
        kind: "license",
        status: "activation_deactivated",
        code: state.code,
        details: sanitizeDetails(state.details),
      };
    }
    throw new ClientContractError(`Unknown License state '${String(state.status)}'`);
  }
  if (state.kind === "release_not_eligible") {
    const release_version = contractString(state.release_version, "Release version");
    const release_platform = contractString(state.release_platform, "Release platform");
    const release_arch = contractString(state.release_arch, "Release architecture");
    if (state.status === "update_required" && state.code === "UPDATE_ENTITLEMENT_REQUIRED") {
      return {
        kind: "release_not_eligible",
        status: "update_required",
        code: state.code,
        release_version,
        release_platform,
        release_arch,
        updates_until: contractDate(state.updates_until, "Release updates_until"),
        released_at: contractDate(state.released_at, "Release released_at"),
        details: sanitizeDetails(state.details),
      };
    }
    throw new ClientContractError(`Unknown Release eligibility state '${String(state.status)}'`);
  }
  throw new ClientContractError(`Unknown entitlement kind '${String(state.kind)}'`);
}

function parseCredentialUpdate(value: unknown): CredentialUpdate {
  const update = contractObject(value, "Credential update");
  if (update.credential_mode !== "opaque" && update.credential_mode !== "signed") {
    throw new ClientContractError(`Unknown credential_mode '${String(update.credential_mode)}'`);
  }
  const parsed: CredentialUpdate = {
    credential_mode: update.credential_mode,
    signed_license_token: update.signed_license_token === null ? null : contractString(update.signed_license_token, "signed_license_token"),
    signed_license_token_expires_at: contractNullableDate(update.signed_license_token_expires_at, "signed_license_token_expires_at"),
    signing_key_id: update.signing_key_id === null ? null : contractString(update.signing_key_id, "signing_key_id"),
  };
  if (parsed.credential_mode === "opaque" && (parsed.signed_license_token || parsed.signed_license_token_expires_at || parsed.signing_key_id)) {
    throw new ClientContractError("Opaque credential update must not contain Signed License Token fields");
  }
  if (parsed.credential_mode === "signed" && (!parsed.signed_license_token || !parsed.signed_license_token_expires_at || !parsed.signing_key_id)) {
    throw new ClientContractError("Signed credential update is incomplete");
  }
  return parsed;
}

function parseActivationResponse(value: unknown): ActivationResponse {
  const response = contractObject(value, "Activation response");
  const state = parseEntitlementState(response.state);
  if (state.kind !== "license" || state.status !== "active") {
    throw new ClientContractError("Successful activation must return an active License state");
  }
  const credential = parseCredentialUpdate(response);
  const terms = parseLicenseTerms(response.terms);
  const licenseExpiresAt = contractNullableDate(response.license_expires_at, "license_expires_at");
  if (JSON.stringify(terms) !== JSON.stringify(state.terms) || licenseExpiresAt !== state.expires_at) {
    throw new ClientContractError("Activation credential fields do not match the active License state");
  }
  return {
    activation_id: contractString(response.activation_id, "activation_id"),
    machine_token: contractString(response.machine_token, "machine_token"),
    ...credential,
    license_expires_at: licenseExpiresAt,
    terms,
    state,
    validation: parseValidationMetadata(response.validation),
    meta: parseResponseMetadata(response.meta),
  };
}

function parseValidateResponse(value: unknown): ValidateResponse {
  const response = contractObject(value, "Validate response");
  const state = parseEntitlementState(response.state);
  if (state.kind === "license" && state.status === "active" && !("credential_update" in response)) {
    throw new ClientContractError("Active License validation is missing credential_update");
  }
  if (!(state.kind === "license" && state.status === "active") && "credential_update" in response) {
    throw new ClientContractError("credential_update is only valid for an active License state");
  }
  return {
    state,
    ...(state.kind === "license" && state.status === "active" && "credential_update" in response
      ? { credential_update: parseCredentialUpdate(response.credential_update) }
      : {}),
    validation: parseValidationMetadata(response.validation),
    meta: parseResponseMetadata(response.meta),
  };
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

function classifyFetchError(error: unknown): { kind: TransportErrorKind; causeCode?: string } {
  const candidate = error as { name?: string; message?: string; cause?: { code?: string } };
  const code = candidate.cause?.code ?? "";
  const message = `${candidate.name ?? ""} ${candidate.message ?? ""}`.toLowerCase();
  if (candidate.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || message.includes("timeout")) return { kind: "timeout", causeCode: code || undefined };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("dns")) return { kind: "dns", causeCode: code || undefined };
  if (code.startsWith("ERR_TLS") || message.includes("certificate") || message.includes("tls")) return { kind: "tls", causeCode: code || undefined };
  return { kind: "network", causeCode: code || undefined };
}

export async function requestClientApi<T>(
  serverUrl: string,
  path: string,
  options: RequestInit = {},
  parseSuccessData?: (value: unknown) => T
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
    const classification = classifyFetchError(error);
    throw new ClientTransportError(
      classification.kind,
      `Unable to reach LicenKit server at ${serverUrl}: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      undefined,
      undefined,
      {},
      classification.causeCode
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
    throw new ClientContractError(`LicenKit server returned a non-JSON ${response.status} response`, response.status, requestIdHeader);
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
    throw new ClientContractError("LicenKit response envelope must be a JSON object", response.status, requestIdHeader);
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
    throw new ClientContractError("LicenKit response does not match the V1 success envelope", response.status, requestIdHeader);
  }
  if (!parseSuccessData) return envelope.data as T;
  try {
    return parseSuccessData(envelope.data);
  } catch (error) {
    if (!(error instanceof ClientContractError)) throw error;
    const dataRequestId = (envelope.data as { meta?: { request_id?: unknown } })?.meta?.request_id;
    throw new ClientContractError(
      error.message,
      response.status,
      typeof dataRequestId === "string" ? dataRequestId : requestIdHeader,
      error.details
    );
  }
}

export interface ClientContext {
  serverUrl: string;
  productId: string;
  fingerprint: string;
  devicePlatform: string;
  releaseVersion: string;
  releasePlatform: string;
  releaseArch: string;
}

export interface ActivateParams extends ClientContext {
  licenseKey: string;
  name?: string;
}

export async function apiActivate(params: ActivateParams): Promise<ActivationResponse> {
  return requestClientApi(params.serverUrl, "/api/v1/client/activate", {
    method: "POST",
    body: JSON.stringify({
      product_id: params.productId,
      license_key: params.licenseKey,
      fingerprint: params.fingerprint,
      device_platform: params.devicePlatform,
      name: params.name,
      release_version: params.releaseVersion,
      release_platform: params.releasePlatform,
      release_arch: params.releaseArch,
    }),
  }, parseActivationResponse);
}

export type ValidateCredential =
  | { kind: "license"; activation_id: string; machine_token: string }
  | { kind: "trial"; trial_id: string; trial_token: string }
  | { kind: "none" };

export interface ValidateParams extends Omit<ClientContext, "devicePlatform"> {
  credential: ValidateCredential;
}

export async function apiValidate(params: ValidateParams): Promise<ValidateResponse> {
  return requestClientApi(params.serverUrl, "/api/v1/client/validate", {
    method: "POST",
    body: JSON.stringify({
      product_id: params.productId,
      fingerprint: params.fingerprint,
      release_version: params.releaseVersion,
      release_platform: params.releasePlatform,
      release_arch: params.releaseArch,
      credential: params.credential,
    }),
  }, parseValidateResponse);
}

export interface DeactivateParams {
  serverUrl: string;
  productId: string;
  activationId: string;
  machineToken: string;
  fingerprint: string;
}

export interface DeactivateResponse {
  activation_id: string;
  status: "deactivated";
  meta: ResponseMetadata;
}

export async function apiDeactivate(params: DeactivateParams): Promise<DeactivateResponse> {
  return requestClientApi(params.serverUrl, "/api/v1/client/deactivate", {
    method: "POST",
    body: JSON.stringify({
      product_id: params.productId,
      activation_id: params.activationId,
      machine_token: params.machineToken,
      fingerprint: params.fingerprint,
    }),
  }, (value) => {
    const response = contractObject(value, "Deactivate response");
    if (response.status !== "deactivated") {
      throw new ClientContractError("Deactivate response status must be 'deactivated'");
    }
    return {
      activation_id: contractString(response.activation_id, "activation_id"),
      status: "deactivated",
      meta: parseResponseMetadata(response.meta),
    };
  });
}
