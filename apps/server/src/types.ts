export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  STORAGE_ENCRYPTION_KEY?: string;
  STORAGE_ENCRYPTION_KEY_ID?: string;
  INITIAL_SETUP_TOKEN?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  ENVIRONMENT?: string;
  APP_VERSION?: string;
  ADMIN_SESSION_TTL_SECONDS?: string;
  CUSTOMER_MAGIC_LINK_TTL_SECONDS?: string;
  CUSTOMER_MAGIC_LINK_COOLDOWN_SECONDS?: string;
  CUSTOMER_SESSION_TTL_SECONDS?: string;
  CUSTOMER_RECENT_AUTH_SECONDS?: string;
  SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS?: string;
}

export type UserRole = "owner" | "admin" | "member" | "viewer";

export interface Variables {
  requestId: string;
  accountId?: string;
  userId?: string;
  userRole?: UserRole;
  userEmail?: string;
  adminSessionId?: string;
  customerId?: string;
  customerEmail?: string;
  customerSessionId?: string;
  customerAuthenticatedAt?: string;
  sessionCsrfTokenHash?: string;
  sessionNamespace?: "admin" | "customer";
}

export type AppContext = {
  Bindings: Env;
  Variables: Variables;
};
