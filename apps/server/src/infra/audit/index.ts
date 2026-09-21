import type { Context } from "hono";
import { ulid } from "ulid";
import type { AppContext } from "../../types";
import { getTenantDB } from "../db";
import { auditLogs } from "../db/schema";
import { AppError } from "../../middleware/error";

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "password_hash",
  "key",
  "licensekey",
  "license_key",
  "machinetoken",
  "machine_token",
  "keymaterial",
  "key_material",
  "privatekey",
  "private_key",
  "seed",
  "secret",
  "webhooksecret",
  "webhook_secret",
  "token",
  "sessiontoken",
  "session_token",
  "paymentconfigs",
  "payment_configs",
]);

/**
 * Recursively redacts sensitive keys from audit log details.
 */
export function redactSensitiveData(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = redactSensitiveData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export interface RecordAuditLogParams {
  c: Context<AppContext>;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  details?: Record<string, any>;
  userId?: string;
  userEmail?: string;
  instanceId?: string;
}

/**
 * Records an administrative audit log entry to the D1 database.
 * Enforces fail-fast behavior: if mandatory tenant or operator fields are missing, throws AppError.
 */
export async function recordAuditLog(params: RecordAuditLogParams): Promise<string> {
  const { c, action, resourceType, resourceId, details } = params;

  const instanceId = params.instanceId || c.get("instanceId");
  const userId = params.userId || c.get("userId");
  const userEmail = params.userEmail || c.get("userEmail");

  if (!instanceId) {
    throw new AppError("AUDIT_MISSING_INSTANCE", "Cannot record audit log without valid instanceId", 500);
  }
  if (!userId || !userEmail) {
    throw new AppError("AUDIT_MISSING_OPERATOR", "Cannot record audit log without valid operator identity", 500);
  }

  const rawIp =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "127.0.0.1";
  const ip = rawIp.slice(0, 45);

  const rawUa = c.req.header("user-agent") || "unknown";
  const userAgent = rawUa.slice(0, 255);

  const sanitizedDetails = details ? redactSensitiveData(details) : {};
  const id = `aud_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();

  const db = getTenantDB(c);
  await db.insert(auditLogs).values({
    id,
    scopeType: "instance",
    instanceId,
    actorType: "user",
    actorUserId: userId,
    actorCustomerId: null,
    action,
    resourceType,
    resourceId: resourceId ?? null,
    requestId: c.get("requestId") || null,
    detailsRedactedJson: JSON.stringify({
      ...sanitizedDetails,
      actor_email: userEmail,
    }),
    ip,
    userAgent,
    createdAt: now,
  });

  return id;
}
