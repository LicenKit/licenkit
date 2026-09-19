import { ulid } from "ulid";

export type LicenseActor =
  | { type: "user"; id: string }
  | { type: "customer"; id: string }
  | { type: "system" };

export function prepareLicenseAudit(input: {
  db: D1Database;
  accountId: string;
  actor: LicenseActor;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}): D1PreparedStatement {
  const id = `aud_${ulid().toLowerCase()}`;
  const actorUserId = input.actor.type === "user" ? input.actor.id : null;
  const actorCustomerId = input.actor.type === "customer" ? input.actor.id : null;
  return input.db.prepare(
    `INSERT INTO audit_logs (
       id, account_id, actor_type, actor_user_id, actor_customer_id,
       action, resource_type, resource_id, request_id, details_redacted_json,
       ip, user_agent, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
  ).bind(
    id,
    input.accountId,
    input.actor.type,
    actorUserId,
    actorCustomerId,
    input.action,
    input.resourceType,
    input.resourceId ?? null,
    input.requestId ?? null,
    JSON.stringify(input.details ?? {}),
    input.ip ?? null,
    input.userAgent ?? null,
    (input.now ?? new Date()).toISOString(),
  );
}
