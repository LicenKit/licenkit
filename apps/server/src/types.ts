export interface Env {
  // Cloudflare Bindings
  DB: D1Database;
  KEYS_KV: KVNamespace;
  EVENT_QUEUE: Queue<any>;
  ASSETS?: Fetcher;

  // Environment Secrets / Variables
  STORAGE_ENCRYPTION_KEY?: string;
  JWT_SECRET?: string;
  ENVIRONMENT?: string;
  APP_VERSION?: string;
}

export type UserRole = "owner" | "admin" | "member" | "viewer";

export interface Variables {
  accountId?: string;
  userId?: string;
  userRole?: UserRole;
  userEmail?: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: Variables;
};
