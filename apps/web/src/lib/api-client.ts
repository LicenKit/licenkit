/**
 * Unified API Client for LicenKit Dashboard
 * Automatically handles JWT Authorization headers and dynamic API Base URL resolution.
 */

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "") + "/api/v1";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface EnvCheckItem {
  key: string;
  label: string;
  category: "secret" | "binding";
  required: boolean;
  status: "ready" | "missing" | "insecure";
  description: string;
  fixHint: string;
}

export interface EnvCheckResponse {
  environment: string;
  version: string;
  all_ready: boolean;
  items: EnvCheckItem[];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("licenkit_token");
  const headers = new Headers(options.headers || {});

  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const url = `${API_BASE}${path}`;
  const response = await fetch(url, { ...options, headers });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const code = data?.error?.code || "REQUEST_FAILED";
    const message = data?.error?.message || response.statusText || "Request failed";
    throw new ApiError(code, message, response.status);
  }

  return data.data;
}

export const api = {
  stats: {
    get: () =>
      request<{
        totalProducts: number;
        totalLicenses: number;
        activatedMachines: number;
        expiringSoon: number;
      }>("/admin/stats"),
  },
  system: {
    getStatus: () => request<{ initialized: boolean; instanceName?: string; instance_name?: string; appUrl?: string; app_url?: string; apiBaseUrl?: string; api_base_url?: string; version: string }>("/system/status"),
    getEnvCheck: () => request<EnvCheckResponse>("/system/env-check"),
    setup: (body: any) => request<any>("/system/setup", { method: "POST", body: JSON.stringify(body) }),
  },
  auth: {
    login: (credentials: { email: string; password: string }) =>
      request<{ session_token: string; sessionToken?: string; user: any; account: any }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(credentials),
      }),
    me: () => request<{ user: any; account: any }>("/auth/me"),
    logout: () => request<{ message: string }>("/auth/logout", { method: "POST" }),
  },
  settings: {
    get: () => request<{ system: any; account: any }>("/admin/settings"),
    getEnvCheck: () => request<EnvCheckResponse>("/admin/settings/env-check"),
    update: (body: any) => request<{ message: string }>("/admin/settings", { method: "PUT", body: JSON.stringify(body) }),
  },
  products: {
    list: () => request<{ items: any[] }>("/admin/products"),
    get: (id: string) => request<any>(`/admin/products/${id}`),
    create: (body: any) => request<any>("/admin/products", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: any) => request<any>(`/admin/products/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    delete: (id: string) => request<any>(`/admin/products/${id}`, { method: "DELETE" }),
  },
  policies: {
    list: (productId?: string) =>
      request<{ items: any[] }>(`/admin/policies${productId ? `?productId=${productId}` : ""}`),
    get: (id: string) => request<any>(`/admin/policies/${id}`),
    create: (body: any) => request<any>("/admin/policies", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: any) => request<any>(`/admin/policies/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    delete: (id: string) => request<any>(`/admin/policies/${id}`, { method: "DELETE" }),
  },
  licenses: {
    list: (paramsOrPage: any = 1, maybeLimit = 20) => {
      let params: any = {};
      if (typeof paramsOrPage === "object" && paramsOrPage !== null) {
        params = paramsOrPage;
      } else {
        params = { page: paramsOrPage, limit: maybeLimit };
      }
      const sp = new URLSearchParams();
      if (params.page) sp.set("page", String(params.page));
      if (params.limit) sp.set("limit", String(params.limit));
      const pid = params.productId || params.product_id;
      if (pid) sp.set("productId", pid);
      const polId = params.policyId || params.policy_id;
      if (polId) sp.set("policyId", polId);
      const email = params.customerEmail || params.customer_email;
      if (email) sp.set("customerEmail", email);
      if (params.status && params.status !== "all") sp.set("status", params.status);
      if (params.query) sp.set("query", params.query);
      const qs = sp.toString();
      return request<{ items: any[]; pagination: any }>(`/admin/licenses${qs ? `?${qs}` : ""}`);
    },
    issue: (body: any) => request<any>("/admin/licenses", { method: "POST", body: JSON.stringify(body) }),
    get: (id: string) => request<any>(`/admin/licenses/${id}`),
    update: (id: string, body: any) => request<any>(`/admin/licenses/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    rotateKey: (id: string, body: any = {}) => request<any>(`/admin/licenses/${id}/rotate-key`, { method: "POST", body: JSON.stringify(body) }),
    revoke: (id: string) => request<any>(`/admin/licenses/${id}/revoke`, { method: "POST" }),
    suspend: (id: string) => request<any>(`/admin/licenses/${id}/suspend`, { method: "POST" }),
    reinstate: (id: string) => request<any>(`/admin/licenses/${id}/reinstate`, { method: "POST" }),
    unbindMachine: (licenseId: string, machineId: string) =>
      request<any>(`/admin/licenses/${licenseId}/machines/${machineId}`, { method: "DELETE" }),
  },
  webhooks: {
    listEndpoints: () => request<{ items: any[] }>("/admin/webhooks"),
    createEndpoint: (body: any) => request<any>("/admin/webhooks", { method: "POST", body: JSON.stringify(body) }),
    testEndpoint: (id: string) => request<any>(`/admin/webhooks/${id}/test`, { method: "POST" }),
    deleteEndpoint: (id: string) => request<any>(`/admin/webhooks/${id}`, { method: "DELETE" }),
    listEvents: () => request<{ items: any[] }>("/admin/webhooks/events"),
  },
  users: {
    list: () => request<{ items: any[] }>("/admin/users"),
    create: (body: { email: string; name: string; password: string; role: "admin" | "member" }) =>
      request<{ id: string; email: string; name: string; role: string }>("/admin/users", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (
      id: string,
      body: { name?: string; role?: "admin" | "member"; isActive?: boolean; password?: string }
    ) =>
      request<{ id: string; email: string; name: string; role: string; isActive: boolean }>(
        `/admin/users/${id}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        }
      ),
    delete: (id: string) => request<{ message: string }>(`/admin/users/${id}`, { method: "DELETE" }),
  },
};
