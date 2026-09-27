import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppContext, InstanceRole } from "../types";
import { AppError, ForbiddenError, UnauthorizedError } from "./error";
import { sha256Hex, timingSafeEqual } from "../infra/crypto";
import { readAdminCookies, readCustomerCookies } from "../services/identity/session";
import { readDeploymentSetupState } from "../services/identity/deployment-provisioning";
import { resolveCustomerSiteBoundary } from "../config/customer-site";

interface AdminSessionRow {
  session_id: string;
  csrf_token_hash: string;
  user_id: string;
  email: string;
  name: string;
  instance_id: string;
  instance_name: string;
  instance_site_url: string;
  role: InstanceRole;
}

interface CustomerSessionRow {
  session_id: string;
  csrf_token_hash: string;
  instance_id: string;
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

function customerSessionTouchError(error: unknown): {
  errorType: string;
  errorCode?: string;
  errorMessage: string;
} {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : undefined;
  const errorCode = typeof record?.code === "string" || typeof record?.code === "number"
    ? String(record.code).slice(0, 128)
    : undefined;
  const rawMessage = typeof record?.message === "string"
    ? record.message.slice(0, 512)
    : String(error).slice(0, 512);
  const errorMessage = rawMessage
    .replace(/\b(?:ast|cst|acf|ccf|mlk|ivk)_[A-Za-z0-9]+\b/g, "[REDACTED_TOKEN]")
    .replace(/(cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(errorCode ? { errorCode } : {}),
    errorMessage,
  };
}

function parseExactSerializedOrigin(requestOrigin: string): boolean {
  try {
    const parsedOrigin = new URL(requestOrigin);
    return parsedOrigin.origin === requestOrigin;
  } catch {
    return false;
  }
}

export const requireAdminAppOrigin: MiddlewareHandler<AppContext> = async (c, next) => {
  const requestOrigin = c.req.header("origin");
  if (!requestOrigin) throw new ForbiddenError("Origin header is required for this request");
  const expectedOrigin = new URL(c.req.url).origin;
  if (!parseExactSerializedOrigin(requestOrigin)) {
    throw new ForbiddenError("Origin header is invalid");
  }
  if (!timingSafeEqual(requestOrigin, expectedOrigin)) {
    throw new ForbiddenError("Cross-origin state change is not allowed");
  }
  await next();
};

export function validateCustomerSiteOrigin(
  requestOrigin: string | undefined,
  expectedOrigin: string,
): void {
  if (!requestOrigin) {
    throw new AppError(
      "CUSTOMER_ORIGIN_REQUIRED",
      "Origin header is required for Customer API requests",
      403,
      { allowedOrigin: expectedOrigin },
    );
  }
  if (!parseExactSerializedOrigin(requestOrigin)) {
    throw new AppError(
      "CUSTOMER_ORIGIN_INVALID",
      "Origin header is not an exact serialized Origin",
      403,
      { requestOrigin, allowedOrigin: expectedOrigin },
    );
  }
  if (!timingSafeEqual(requestOrigin, expectedOrigin)) {
    throw new AppError(
      "CUSTOMER_ORIGIN_NOT_ALLOWED",
      "Origin is not allowed to access the Customer API",
      403,
      { requestOrigin, allowedOrigin: expectedOrigin },
    );
  }
}

export const requireCustomerSiteOrigin: MiddlewareHandler<AppContext> = async (c, next) => {
  let expectedOrigin = c.get("customerSiteOrigin");
  if (!expectedOrigin) {
    const boundary = await resolveCustomerSiteBoundary(c.env.DB, c.req.url, c.env.ENVIRONMENT);
    c.set("customerRequestInstanceId", boundary.instanceId);
    c.set("customerSiteOrigin", boundary.customerSiteOrigin);
    expectedOrigin = boundary.customerSiteOrigin;
  }
  const requestOrigin = c.req.header("origin");
  const requestUrlOrigin = new URL(c.req.url).origin;

  // Browsers do not attach Origin to ordinary same-origin GET requests. This
  // branch is safe only when the configured Customer Site and the API request
  // are the same Origin; cross-Origin requests must still prove their Origin.
  if (
    !requestOrigin &&
    c.req.method === "GET" &&
    timingSafeEqual(requestUrlOrigin, expectedOrigin)
  ) {
    await next();
    return;
  }

  validateCustomerSiteOrigin(requestOrigin, expectedOrigin);
  await next();
};

export const adminSessionAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const cookies = readAdminCookies(c);
  if (!cookies.sessionToken) {
    throw new UnauthorizedError("Administrator session cookie is missing");
  }
  const tokenHash = await sha256Hex(cookies.sessionToken);
  const now = new Date().toISOString();
  const row = await one<AdminSessionRow>(
    c.env.DB
      .prepare(
        `WITH active_instance AS (
           SELECT id, name, site_url
           FROM instances
           WHERE status = 'active'
         )
         SELECT s.id AS session_id, s.csrf_token_hash,
                u.id AS user_id, u.email, u.name,
                instance.id AS instance_id, instance.name AS instance_name,
                instance.site_url AS instance_site_url,
                membership.role
         FROM admin_sessions AS s
         JOIN users AS u ON u.id = s.user_id
         JOIN active_instance AS instance ON 1 = 1
         JOIN instance_memberships AS membership
           ON membership.instance_id = instance.id
          AND membership.user_id = u.id
          AND membership.status = 'active'
         WHERE s.session_token_hash = ?1
           AND s.revoked_at IS NULL AND s.expires_at > ?2
           AND (SELECT COUNT(*) FROM active_instance) = 1
         LIMIT 1`
      )
      .bind(tokenHash, now)
  );
  if (!row) throw new UnauthorizedError("Administrator session is invalid or expired");

  setContext(c, {
    instanceId: row.instance_id,
    userId: row.user_id,
    instanceRole: row.role,
    userEmail: row.email,
    adminSessionId: row.session_id,
    sessionCsrfTokenHash: row.csrf_token_hash,
    sessionNamespace: "admin",
  });
  await c.env.DB
    .prepare(
      `UPDATE admin_sessions SET last_seen_at = ?1
       WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL`
    )
    .bind(now, row.session_id, row.user_id)
    .run();
  await next();
};

export const customerSessionAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const cookies = readCustomerCookies(c);
  if (!cookies.instanceId || !cookies.sessionToken) {
    throw new UnauthorizedError("Customer session cookie is missing");
  }
  const tokenHash = await sha256Hex(cookies.sessionToken);
  const now = new Date().toISOString();
  const row = await one<CustomerSessionRow>(
    c.env.DB
      .prepare(
        `SELECT s.id AS session_id, s.csrf_token_hash, s.instance_id,
                s.customer_id, c.email, s.created_at AS authenticated_at
         FROM customer_sessions AS s
         JOIN customers AS c ON c.instance_id = s.instance_id AND c.id = s.customer_id
         JOIN instances AS instance ON instance.id = s.instance_id
         WHERE s.instance_id = ?1 AND s.session_token_hash = ?2
           AND s.revoked_at IS NULL AND s.expires_at > ?3
           AND c.status = 'active' AND instance.status = 'active'
         LIMIT 1`
      )
      .bind(cookies.instanceId, tokenHash, now)
  );
  if (!row) throw new UnauthorizedError("Customer session is invalid or expired");
  let requestInstanceId = c.get("customerRequestInstanceId");
  if (!requestInstanceId) {
    const boundary = await resolveCustomerSiteBoundary(c.env.DB, c.req.url, c.env.ENVIRONMENT);
    c.set("customerRequestInstanceId", boundary.instanceId);
    c.set("customerSiteOrigin", boundary.customerSiteOrigin);
    requestInstanceId = boundary.instanceId;
  }
  if (!requestInstanceId || !timingSafeEqual(row.instance_id, requestInstanceId)) {
    throw new UnauthorizedError("Customer session does not belong to this Admin/API Origin");
  }

  setContext(c, {
    instanceId: row.instance_id,
    customerId: row.customer_id,
    customerEmail: row.email,
    customerSessionId: row.session_id,
    customerAuthenticatedAt: row.authenticated_at,
    sessionCsrfTokenHash: row.csrf_token_hash,
    sessionNamespace: "customer",
  });
  await next();
  if (c.res.status >= 200 && c.res.status < 300) {
    try {
      await c.env.DB
        .prepare(
          `UPDATE customer_sessions SET last_seen_at = ?1
           WHERE instance_id = ?2 AND id = ?3 AND revoked_at IS NULL`
        )
        .bind(now, row.instance_id, row.session_id)
        .run();
    } catch (error) {
      console.error("Customer Session last_seen update failed", {
        code: "CUSTOMER_SESSION_LAST_SEEN_UPDATE_FAILED",
        requestId: c.get("requestId") || c.req.header("x-request-id") || "unknown",
        instanceId: row.instance_id,
        sessionId: row.session_id,
        ...customerSessionTouchError(error),
      });
    }
  }
};

function csrfGuard(namespace: "admin" | "customer"): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if ((c as any).get("sessionNamespace") !== namespace) {
      throw new ForbiddenError("Session namespace does not match this route");
    }
    const cookies = namespace === "admin" ? readAdminCookies(c) : readCustomerCookies(c);
    const cookieToken = cookies.csrfToken;
    const headerToken = c.req.header("x-csrf-token");
    if (namespace === "customer" && !cookieToken) {
      throw new AppError(
        "CUSTOMER_CSRF_COOKIE_MISSING",
        "Customer CSRF cookie is missing",
        403,
      );
    }
    if (namespace === "customer" && !headerToken) {
      throw new AppError(
        "CUSTOMER_CSRF_HEADER_MISSING",
        "X-CSRF-Token header is missing",
        403,
      );
    }
    if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
      if (namespace === "customer") {
        throw new AppError(
          "CUSTOMER_CSRF_TOKEN_MISMATCH",
          "X-CSRF-Token header does not match the Customer CSRF cookie",
          403,
        );
      }
      throw new ForbiddenError("CSRF token is missing or does not match the session cookie");
    }
    const expectedHash = (c as any).get("sessionCsrfTokenHash") as string | undefined;
    const actualHash = await sha256Hex(headerToken);
    if (!expectedHash || !timingSafeEqual(actualHash, expectedHash)) {
      if (namespace === "customer") {
        throw new AppError(
          "CUSTOMER_CSRF_SESSION_MISMATCH",
          "Customer CSRF token is not bound to the current session",
          403,
        );
      }
      throw new ForbiddenError("CSRF token is not bound to the current session");
    }
    await next();
  };
}

export const adminCsrf = csrfGuard("admin");
export const customerCsrf = csrfGuard("customer");

export async function readBoundCustomerCsrfToken(c: Parameters<MiddlewareHandler<AppContext>>[0]): Promise<string> {
  if ((c as any).get("sessionNamespace") !== "customer") {
    throw new ForbiddenError("Session namespace does not match this route");
  }
  const cookieToken = readCustomerCookies(c).csrfToken;
  if (!cookieToken) {
    throw new AppError(
      "CUSTOMER_CSRF_COOKIE_MISSING",
      "Customer CSRF cookie is missing",
      403,
    );
  }
  const expectedHash = (c as any).get("sessionCsrfTokenHash") as string | undefined;
  const actualHash = await sha256Hex(cookieToken);
  if (!expectedHash || !timingSafeEqual(actualHash, expectedHash)) {
    throw new AppError(
      "CUSTOMER_CSRF_SESSION_MISMATCH",
      "Customer CSRF token is not bound to the current session",
      403,
    );
  }
  return cookieToken;
}

const ADMIN_PERMISSION_DECLARATION = Symbol("admin-permission-declaration");
type DeclaredAdminPermissionHandler = MiddlewareHandler<AppContext> & {
  [ADMIN_PERMISSION_DECLARATION]?: readonly InstanceRole[];
};

interface AdminRouteLike {
  method: string;
  path: string;
  handler: unknown;
}

export interface DeclaredAdminRoutePermission {
  method: string;
  path: string;
  allowedRoles: readonly InstanceRole[];
}

export interface AdminRoutePermissionInspection {
  declared: DeclaredAdminRoutePermission[];
  undeclared: Array<{ method: string; path: string }>;
  conflicts: Array<{
    method: string;
    path: string;
    declarations: readonly (readonly InstanceRole[])[];
  }>;
}

export function getDeclaredAdminRoles(handler: unknown): readonly InstanceRole[] | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as DeclaredAdminPermissionHandler)[ADMIN_PERMISSION_DECLARATION];
}

function sameRoles(left: readonly InstanceRole[], right: readonly InstanceRole[]): boolean {
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
    declarations: Array<readonly InstanceRole[]>;
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

export function requireRole(allowedRoles: InstanceRole[]): MiddlewareHandler<AppContext> {
  const handler: DeclaredAdminPermissionHandler = async (c, next) => {
    const role = c.get("instanceRole");
    if (!role || !allowedRoles.includes(role)) {
      throw new ForbiddenError("Insufficient permissions to perform this action");
    }
    await next();
  };
  handler[ADMIN_PERMISSION_DECLARATION] = Object.freeze([...allowedRoles]);
  return handler;
}

export const setupGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  const state = await readDeploymentSetupState(c.env.DB);
  if (state.status === "completed") {
    throw new AppError("SETUP_ALREADY_COMPLETED", "Instance setup has already completed", 409);
  }
  if (state.status === "inconsistent") {
    throw new AppError("SETUP_STATE_INCONSISTENT", "Database initialization state is inconsistent", 500);
  }
  await next();
};

export const sessionAuth = adminSessionAuth;
