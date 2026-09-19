import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppContext, UserRole } from "../types";
import { AppError, ForbiddenError, UnauthorizedError } from "./error";
import { sha256Hex, timingSafeEqual } from "../infra/crypto";
import { readAdminCookies, readCustomerCookies } from "../services/identity/session";

interface AdminSessionRow {
  session_id: string;
  csrf_token_hash: string;
  account_id: string;
  user_id: string;
  email: string;
  role: UserRole;
}

interface CustomerSessionRow {
  session_id: string;
  csrf_token_hash: string;
  account_id: string;
  customer_id: string;
  email: string;
  authenticated_at: string;
}

async function one<T>(statement: D1PreparedStatement): Promise<T | undefined> {
  const result = await statement.all<T>();
  return result.results[0];
}

function setContext(c: any, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) c.set(key, value);
}

export const requireExactOrigin: MiddlewareHandler<AppContext> = async (c, next) => {
  const requestOrigin = c.req.header("origin");
  if (!requestOrigin) throw new ForbiddenError("Origin header is required for this request");
  const configured = await one<{ app_url: string }>(
    c.env.DB.prepare(`SELECT app_url FROM system_settings WHERE id = 'current'`)
  );
  const expectedOrigin = configured ? new URL(configured.app_url).origin : new URL(c.req.url).origin;
  let normalizedRequestOrigin: string;
  try {
    normalizedRequestOrigin = new URL(requestOrigin).origin;
  } catch {
    throw new ForbiddenError("Origin header is invalid");
  }
  if (!timingSafeEqual(normalizedRequestOrigin, expectedOrigin)) {
    throw new ForbiddenError("Cross-origin state change is not allowed");
  }
  await next();
};

export const adminSessionAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const cookies = readAdminCookies(c);
  if (!cookies.accountId || !cookies.sessionToken) {
    throw new UnauthorizedError("Administrator session cookie is missing");
  }
  const tokenHash = await sha256Hex(cookies.sessionToken);
  const now = new Date().toISOString();
  const row = await one<AdminSessionRow>(
    c.env.DB
      .prepare(
        `SELECT s.id AS session_id, s.csrf_token_hash, s.account_id,
                u.id AS user_id, u.email, u.role
         FROM admin_sessions AS s
         JOIN users AS u ON u.account_id = s.account_id AND u.id = s.user_id
         JOIN accounts AS a ON a.id = s.account_id
         WHERE s.account_id = ?1 AND s.session_token_hash = ?2
           AND s.revoked_at IS NULL AND s.expires_at > ?3
           AND u.status = 'active' AND a.status = 'active'
         LIMIT 1`
      )
      .bind(cookies.accountId, tokenHash, now)
  );
  if (!row) throw new UnauthorizedError("Administrator session is invalid or expired");

  setContext(c, {
    accountId: row.account_id,
    userId: row.user_id,
    userRole: row.role,
    userEmail: row.email,
    adminSessionId: row.session_id,
    sessionCsrfTokenHash: row.csrf_token_hash,
    sessionNamespace: "admin",
  });
  await c.env.DB
    .prepare(
      `UPDATE admin_sessions SET last_seen_at = ?1
       WHERE account_id = ?2 AND id = ?3 AND revoked_at IS NULL`
    )
    .bind(now, row.account_id, row.session_id)
    .run();
  await next();
};

export const customerSessionAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const cookies = readCustomerCookies(c);
  if (!cookies.accountId || !cookies.sessionToken) {
    throw new UnauthorizedError("Customer session cookie is missing");
  }
  const tokenHash = await sha256Hex(cookies.sessionToken);
  const now = new Date().toISOString();
  const row = await one<CustomerSessionRow>(
    c.env.DB
      .prepare(
        `SELECT s.id AS session_id, s.csrf_token_hash, s.account_id,
                s.customer_id, c.email, s.created_at AS authenticated_at
         FROM customer_sessions AS s
         JOIN customers AS c ON c.account_id = s.account_id AND c.id = s.customer_id
         JOIN accounts AS a ON a.id = s.account_id
         WHERE s.account_id = ?1 AND s.session_token_hash = ?2
           AND s.revoked_at IS NULL AND s.expires_at > ?3
           AND c.status = 'active' AND a.status = 'active'
         LIMIT 1`
      )
      .bind(cookies.accountId, tokenHash, now)
  );
  if (!row) throw new UnauthorizedError("Customer session is invalid or expired");

  setContext(c, {
    accountId: row.account_id,
    customerId: row.customer_id,
    customerEmail: row.email,
    customerSessionId: row.session_id,
    customerAuthenticatedAt: row.authenticated_at,
    sessionCsrfTokenHash: row.csrf_token_hash,
    sessionNamespace: "customer",
  });
  await c.env.DB
    .prepare(
      `UPDATE customer_sessions SET last_seen_at = ?1
       WHERE account_id = ?2 AND id = ?3 AND revoked_at IS NULL`
    )
    .bind(now, row.account_id, row.session_id)
    .run();
  await next();
};

function csrfGuard(namespace: "admin" | "customer"): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if ((c as any).get("sessionNamespace") !== namespace) {
      throw new ForbiddenError("Session namespace does not match this route");
    }
    const cookies = namespace === "admin" ? readAdminCookies(c) : readCustomerCookies(c);
    const cookieToken = cookies.csrfToken;
    const headerToken = c.req.header("x-csrf-token");
    if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
      throw new ForbiddenError("CSRF token is missing or does not match the session cookie");
    }
    const expectedHash = (c as any).get("sessionCsrfTokenHash") as string | undefined;
    const actualHash = await sha256Hex(headerToken);
    if (!expectedHash || !timingSafeEqual(actualHash, expectedHash)) {
      throw new ForbiddenError("CSRF token is not bound to the current session");
    }
    await next();
  };
}

export const adminCsrf = csrfGuard("admin");
export const customerCsrf = csrfGuard("customer");

const ADMIN_PERMISSION_DECLARATION = Symbol("admin-permission-declaration");
type DeclaredAdminPermissionHandler = MiddlewareHandler<AppContext> & {
  [ADMIN_PERMISSION_DECLARATION]?: readonly UserRole[];
};

interface AdminRouteLike {
  method: string;
  path: string;
  handler: unknown;
}

export interface DeclaredAdminRoutePermission {
  method: string;
  path: string;
  allowedRoles: readonly UserRole[];
}

export interface AdminRoutePermissionInspection {
  declared: DeclaredAdminRoutePermission[];
  undeclared: Array<{ method: string; path: string }>;
  conflicts: Array<{
    method: string;
    path: string;
    declarations: readonly (readonly UserRole[])[];
  }>;
}

export function getDeclaredAdminRoles(handler: unknown): readonly UserRole[] | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as DeclaredAdminPermissionHandler)[ADMIN_PERMISSION_DECLARATION];
}

function sameRoles(left: readonly UserRole[], right: readonly UserRole[]): boolean {
  return left.length === right.length && left.every((role, index) => role === right[index]);
}

function isSameOrChildPath(path: string, prefix: string): boolean {
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

/**
 * Produces a deterministic view of the permission metadata attached to Hono
 * route handlers. This is used by tests and readiness checks to ensure a newly
 * mounted Admin business route cannot silently omit its declaration.
 */
export function inspectAdminRoutePermissions(
  routes: readonly AdminRouteLike[],
  options: { pathPrefix: string; excludedPathPrefixes?: readonly string[] },
): AdminRoutePermissionInspection {
  const excluded = options.excludedPathPrefixes ?? [];
  const endpoints = new Map<string, {
    method: string;
    path: string;
    declarations: Array<readonly UserRole[]>;
  }>();

  for (const route of routes) {
    const method = route.method.toUpperCase();
    if (method === "ALL" || !isSameOrChildPath(route.path, options.pathPrefix)) continue;
    if (excluded.some((prefix) => isSameOrChildPath(route.path, prefix))) continue;
    const key = `${method} ${route.path}`;
    const endpoint = endpoints.get(key) ?? { method, path: route.path, declarations: [] };
    const declaration = getDeclaredAdminRoles(route.handler);
    if (declaration && !endpoint.declarations.some((roles) => sameRoles(roles, declaration))) {
      endpoint.declarations.push(declaration);
    }
    endpoints.set(key, endpoint);
  }

  const declared: DeclaredAdminRoutePermission[] = [];
  const undeclared: Array<{ method: string; path: string }> = [];
  const conflicts: AdminRoutePermissionInspection["conflicts"] = [];
  for (const endpoint of endpoints.values()) {
    if (endpoint.declarations.length === 0) {
      undeclared.push({ method: endpoint.method, path: endpoint.path });
    } else if (endpoint.declarations.length > 1) {
      conflicts.push({
        method: endpoint.method,
        path: endpoint.path,
        declarations: endpoint.declarations,
      });
    } else {
      declared.push({
        method: endpoint.method,
        path: endpoint.path,
        allowedRoles: endpoint.declarations[0],
      });
    }
  }

  const byRoute = (left: { method: string; path: string }, right: { method: string; path: string }) =>
    `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`);
  declared.sort(byRoute);
  undeclared.sort(byRoute);
  conflicts.sort(byRoute);
  return { declared, undeclared, conflicts };
}

export const requireDeclaredAdminPermission: MiddlewareHandler<AppContext> = async (c, next) => {
  const routes = matchedRoutes(c);
  const endpoint = [...routes].reverse().find((route) => route.method !== "ALL");
  const declaration = endpoint && routes
    .filter((route) => route.method === endpoint.method && route.path === endpoint.path)
    .map((route) => getDeclaredAdminRoles(route.handler))
    .find((roles) => roles !== undefined);
  if (!declaration) {
    throw new ForbiddenError("Admin route permission is not declared");
  }
  await next();
};

export function requireRole(allowedRoles: UserRole[]): MiddlewareHandler<AppContext> {
  const handler: DeclaredAdminPermissionHandler = async (c, next) => {
    const role = c.get("userRole");
    if (!role || !allowedRoles.includes(role)) {
      throw new ForbiddenError("Insufficient permissions to perform this action");
    }
    await next();
  };
  handler[ADMIN_PERMISSION_DECLARATION] = Object.freeze([...allowedRoles]);
  return handler;
}

export const setupGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  const state = await one<{ settings_count: number; account_count: number; user_count: number }>(
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM system_settings) AS settings_count,
         (SELECT COUNT(*) FROM accounts) AS account_count,
         (SELECT COUNT(*) FROM users) AS user_count`
    )
  );
  if (!state) throw new AppError("SETUP_STATE_UNAVAILABLE", "Setup state could not be read", 500);
  if (state.settings_count !== 0 || state.account_count !== 0 || state.user_count !== 0) {
    throw new AppError("SETUP_ALREADY_COMPLETED", "Instance setup has already completed", 409);
  }
  await next();
};

export const sessionAuth = adminSessionAuth;
