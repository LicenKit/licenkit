export class ClientApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number = 400) {
    super(message);
    this.name = "ClientApiError";
    this.code = code;
    this.status = status;
  }
}

export async function requestClientApi<T = any>(
  serverUrl: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, "")}${path}`;
  let res: Response;

  try {
    res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "LicenKit-CLI/1.0",
        ...(options.headers || {}),
      },
    });
  } catch (err: any) {
    throw new ClientApiError(
      "NETWORK_ERROR",
      `Failed to connect to LicenKit server at ${serverUrl}: ${err.message}`
    );
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new ClientApiError("INVALID_RESPONSE", `Server returned non-JSON response (${res.status} ${res.statusText})`, res.status);
  }

  if (!res.ok || body.success === false) {
    const errCode = body.error?.code || "API_ERROR";
    const errMsg = body.error?.message || `Server responded with HTTP ${res.status}`;
    throw new ClientApiError(errCode, errMsg, res.status);
  }

  return body.data as T;
}

export interface ActivateParams {
  serverUrl: string;
  accountId: string;
  licenseKey: string;
  fingerprint: string;
  platform?: string;
  name?: string;
}

export interface ActivateResponse {
  activated: boolean;
  reused: boolean;
  machine_id: string;
  scheme: string;
  token: string | null;
  token_expires_at: number | string | null;
  license_expires_at: number | string | null;
  token_expires_at_iso?: string | null;
  license_expires_at_iso?: string | null;
  policy: {
    name: string;
    max_machines: number;
    offline_grace_period: number;
    features: string[];
  };
}

export async function apiActivate(params: ActivateParams): Promise<ActivateResponse> {
  return await requestClientApi<ActivateResponse>(params.serverUrl, "/api/v1/client/activate", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      license_key: params.licenseKey,
      fingerprint: params.fingerprint,
      platform: params.platform,
      name: params.name,
    }),
  });
}

export interface ValidateParams {
  serverUrl: string;
  accountId: string;
  licenseKey: string;
  fingerprint: string;
}

export interface ValidateResponse {
  valid: boolean;
  scheme?: string;
  token?: string | null;
  token_expires_at?: number | string | null;
  license_expires_at?: number | string | null;
  token_expires_at_iso?: string | null;
  license_expires_at_iso?: string | null;
  last_heartbeat_at?: number | string;
  last_heartbeat_at_iso?: string;
  reason?: string;
}

export async function apiValidate(params: ValidateParams): Promise<ValidateResponse> {
  return await requestClientApi<ValidateResponse>(params.serverUrl, "/api/v1/client/validate", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      license_key: params.licenseKey,
      fingerprint: params.fingerprint,
    }),
  });
}

export interface DeactivateParams {
  serverUrl: string;
  accountId: string;
  licenseKey: string;
  fingerprint: string;
}

export interface DeactivateResponse {
  deactivated: boolean;
  message: string;
}

export async function apiDeactivate(params: DeactivateParams): Promise<DeactivateResponse> {
  return await requestClientApi<DeactivateResponse>(params.serverUrl, "/api/v1/client/deactivate", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      license_key: params.licenseKey,
      fingerprint: params.fingerprint,
    }),
  });
}

export interface ProductPublicKeyResponse {
  productId: string;
  kid: string;
  algorithm: string;
  publicKey: string;
}

export async function apiFetchProductPublicKey(
  serverUrl: string,
  accountId: string,
  productId: string
): Promise<ProductPublicKeyResponse> {
  return await requestClientApi<ProductPublicKeyResponse>(
    serverUrl,
    `/api/v1/client/products/${productId}/pubkey?accountId=${encodeURIComponent(accountId)}`,
    { method: "GET" }
  );
}
