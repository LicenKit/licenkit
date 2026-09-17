import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../types";
import { UnauthorizedError, ForbiddenError } from "./error";
import { verifyJWT } from "../infra/crypto";
import { getTenantDB } from "../infra/db";
import { systemSettings } from "../infra/db/schema";
import { eq } from "drizzle-orm";

const DEFAULT_JWT_SECRET = "licenkit-development-jwt-secret-do-not-use-in-production";

/**
 * Validates Bearer Session JWT Token.
 * Attaches userId, accountId, userRole, userEmail to Hono Context.
 */
export const sessionAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }

  const token = authHeader.substring(7).trim();
  const secret = c.env.JWT_SECRET || DEFAULT_JWT_SECRET;
  const payload = await verifyJWT(token, secret);

  if (!payload) {
    throw new UnauthorizedError("Session expired or token invalid. Please login again.");
  }

  c.set("userId", payload.userId);
  c.set("accountId", payload.accountId);
  c.set("userRole", payload.role);
  c.set("userEmail", payload.email);

  await next();
};

/**
 * Role-Based Access Control Guard
 */
export function requireRole(allowedRoles: ("owner" | "admin" | "member")[]): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const role = c.get("userRole");
    if (!role || !allowedRoles.includes(role)) {
      throw new ForbiddenError("Insufficient permissions to perform this action");
    }
    await next();
  };
}

/**
 * Setup Guard: Ensures system is NOT initialized before accessing /system/setup
 */
export const setupGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  const db = getTenantDB(c);
  const existing = await db
    .select({ id: systemSettings.id })
    .from(systemSettings)
    .where(eq(systemSettings.id, "current"))
    .get();

  if (existing) {
    throw new ForbiddenError("Instance has already been initialized");
  }

  await next();
};
