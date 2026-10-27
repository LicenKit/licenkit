import { ulid } from "ulid";
import { hashPassword, sha256Hex, verifyPassword } from "../../infra/crypto";
import { AppError } from "../../middleware/error";
import { prepareAuditInsert } from "./audit";
import { createOneTimeLinkSecret } from "./one-time-link";

interface RecoveryRequestContext {
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

interface PreparedRecoveryCredential {
  id: string;
  credential: string;
  statements: D1PreparedStatement[];
}

function credentialAudit(db: D1Database, userId: string, id: string, action: string, now: string, request: RecoveryRequestContext) {
  return db.prepare(
    `INSERT INTO audit_logs (id, scope_type, instance_id, actor_type, actor_user_id, actor_customer_id,
       action, resource_type, resource_id, request_id, details_redacted_json, ip, user_agent, created_at)
     SELECT ?1, 'identity', NULL, 'user', ?2, NULL, ?3,
       'user_recovery_credential', ?4, ?5, '{}', ?6, ?7, ?8
     WHERE EXISTS (SELECT 1 FROM user_recovery_credentials WHERE id = ?4 AND user_id = ?2)`,
  ).bind(`aud_${ulid().toLowerCase()}`, userId, action, id, request.requestId ?? null,
    request.ip?.slice(0, 45) ?? null, request.userAgent?.slice(0, 255) ?? null, now);
}

async function prepareCredential(db: D1Database, userId: string, now: string) {
  const { token: credential, tokenHash } = await createOneTimeLinkSecret("rcv");
  const id = `rcr_${ulid().toLowerCase()}`;
  return {
    id, credential,
    statement: db.prepare(
      `INSERT INTO user_recovery_credentials (id, user_id, credential_hash, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(id, userId, tokenHash, now),
    tokenHash,
  };
}

/** Prepared inside the password-authenticated login/setup/acceptance transaction. */
export async function prepareInitialRecoveryCredential(input: {
  db: D1Database; userId: string; now: string; request: RecoveryRequestContext;
}): Promise<PreparedRecoveryCredential | null> {
  const { db, userId, now, request } = input;
  const existing = await db.prepare(
    `SELECT id FROM user_recovery_credentials WHERE user_id = ?1 AND consumed_at IS NULL AND revoked_at IS NULL LIMIT 1`,
  ).bind(userId).all<{ id: string }>();
  if (existing.results[0]) return null;
  const prepared = await prepareCredential(db, userId, now);
  return {
    id: prepared.id, credential: prepared.credential,
    statements: [
      // A concurrent first login may already have issued the credential. In that
      // expected case insert nothing and return no plaintext to this caller.
      db.prepare(
        `INSERT INTO user_recovery_credentials (id, user_id, credential_hash, created_at)
         SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS
         (SELECT 1 FROM user_recovery_credentials WHERE user_id = ?2 AND consumed_at IS NULL AND revoked_at IS NULL)`,
      ).bind(prepared.id, userId, prepared.tokenHash, now),
      credentialAudit(db, userId, prepared.id, "identity.recovery_credential.issued", now, request),
    ],
  };
}

export async function regenerateRecoveryCredential(input: {
  db: D1Database; userId: string; currentPassword: string; request: RecoveryRequestContext;
}): Promise<string> {
  const { db, userId, request } = input;
  const result = await db.prepare(`SELECT password_hash FROM users WHERE id = ?1 LIMIT 1`)
    .bind(userId).all<{ password_hash: string }>();
  const user = result.results[0];
  if (!user || !(await verifyPassword(input.currentPassword, user.password_hash))) {
    throw new AppError("CURRENT_PASSWORD_INVALID", "The current password is invalid", 400);
  }
  const now = new Date().toISOString();
  const prepared = await prepareCredential(db, userId, now);
  // Every write is guarded by the password verified above. The transaction
  // prevents a concurrent password reset from authorizing a new credential.
  const results = await db.batch([
    db.prepare(`UPDATE user_recovery_credentials SET revoked_at = ?1
      WHERE user_id = ?2 AND consumed_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND password_hash = ?3)`)
      .bind(now, userId, user.password_hash),
    db.prepare(`INSERT INTO user_recovery_credentials (id, user_id, credential_hash, created_at)
      SELECT ?1, ?2, ?3, ?4 FROM users WHERE id = ?2 AND password_hash = ?5`)
      .bind(prepared.id, userId, prepared.tokenHash, now, user.password_hash),
    credentialAudit(db, userId, prepared.id, "identity.recovery_credential.regenerated", now, request),
  ]);
  if (Number(results[1].meta.changes) !== 1) throw new AppError("CURRENT_PASSWORD_INVALID", "The current password is invalid", 400);
  return prepared.credential;
}

export async function recoverPasswordWithCredential(input: {
  db: D1Database; email: string; credential: string; newPassword: string; request: RecoveryRequestContext;
}): Promise<string> {
  const { db, request } = input;
  const result = await db.prepare(
    `SELECT credential.id, credential.user_id FROM user_recovery_credentials AS credential
     JOIN users AS user ON user.id = credential.user_id
     WHERE user.email = ?1 COLLATE NOCASE AND credential.credential_hash = ?2
       AND credential.consumed_at IS NULL AND credential.revoked_at IS NULL LIMIT 1`,
  ).bind(input.email.trim().toLowerCase(), await sha256Hex(input.credential)).all<{ id: string; user_id: string }>();
  const previous = result.results[0];
  if (!previous) throw invalidCredential();
  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date().toISOString();
  const replacement = await prepareCredential(db, previous.user_id, now);
  try {
    await db.batch([
      // A trigger rejects a concurrent replay before any credential or password changes.
      db.prepare(`UPDATE user_recovery_credentials SET consumed_at = ?1 WHERE id = ?2`).bind(now, previous.id),
      db.prepare(`UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3`).bind(passwordHash, now, previous.user_id),
      db.prepare(`UPDATE admin_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL`).bind(now, previous.user_id),
      replacement.statement,
      prepareAuditInsert({ db, scopeType: "identity", actor: { type: "user", id: previous.user_id },
        action: "identity.password.recovered", resourceType: "user", resourceId: previous.user_id,
        details: { recovery_credential_replaced: true, all_sessions_revoked: true }, ...request,
        requestId: request.requestId ?? undefined, now }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("RECOVERY_CREDENTIAL_INVALID")) throw invalidCredential();
    throw error;
  }
  return replacement.credential;
}

function invalidCredential(): AppError {
  return new AppError("RECOVERY_CREDENTIAL_INVALID", "The recovery credential is invalid or has already been used.", 400);
}
