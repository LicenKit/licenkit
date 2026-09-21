import { ulid } from "ulid";

export interface AuditActor {
  type: "user" | "customer" | "system";
  id?: string | null;
}

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "licensekey",
  "machinetoken",
  "secret",
  "token",
  "sessiontoken",
  "csrftoken",
  "accessurl",
  "payload",
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, "")) ? "[REDACTED]" : redact(nested),
    ])
  );
}

export function serializeRedactedAuditDetails(
  details: Record<string, unknown>,
): string {
  return JSON.stringify(redact(details));
}

export function prepareAuditInsert(input: {
  db: D1Database;
  accountId: string;
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  now?: string;
}): D1PreparedStatement {
  if (input.actor.type !== "system" && !input.actor.id) {
    throw new Error("Audit actor id is required");
  }
  const id = `aud_${ulid().toLowerCase()}`;
  return input.db
    .prepare(
      `INSERT INTO audit_logs (
         id, account_id, actor_type, actor_user_id, actor_customer_id,
         action, resource_type, resource_id, request_id,
         details_redacted_json, ip, user_agent, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    )
    .bind(
      id,
      input.accountId,
      input.actor.type,
      input.actor.type === "user" ? input.actor.id : null,
      input.actor.type === "customer" ? input.actor.id : null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.requestId ?? null,
      serializeRedactedAuditDetails(input.details ?? {}),
      input.ip?.slice(0, 45) ?? null,
      input.userAgent?.slice(0, 255) ?? null,
      input.now ?? new Date().toISOString()
    );
}
