import { ulid } from "ulid";
import type { Env } from "../../types";
import { getStorageEncryptionKey, hashPassword, sha256Hex } from "../../infra/crypto";
import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../../infra/delivery/crypto";
import { getEmailProviderAdapter } from "../../infra/email/provider";
import { AppError } from "../../middleware/error";
import { prepareAuditInsert } from "./audit";
import { hashOneTimeLinkToken, prepareOneTimeLink } from "./one-time-link";

const RESET_TTL_MS = 15 * 60_000;
const MAX_SEND_ATTEMPTS = 4;

interface RequestDetails {
  requestId?: string;
  ip?: string | null;
  userAgent?: string | null;
}

function configurationError(): AppError {
  return new AppError("PASSWORD_RESET_UNAVAILABLE", "Password recovery by email is temporarily unavailable. Contact the deployment administrator.", 503);
}

export function passwordResetEmailConfiguration(env: Env) {
  const apiKey = env.IDENTITY_EMAIL_API_KEY?.trim();
  const from = env.IDENTITY_EMAIL_FROM?.trim();
  const templateRef = env.IDENTITY_PASSWORD_RESET_TEMPLATE?.trim();
  if (!apiKey || !from || !templateRef || [apiKey, from, templateRef].some((value) => value.startsWith("replace-with-"))) {
    throw configurationError();
  }
  const adapter = getEmailProviderAdapter("resend");
  try {
    const credential = adapter.validateCredentialEnvelope({ version: 1, apiKey });
    adapter.validateSendInput({ from, to: "validation@example.com", templateRef, variables: {} });
    getStorageEncryptionKey(env);
    return { adapter, credential, from, templateRef };
  } catch {
    // Configuration failure is shared by all callers, before any account lookup.
    throw configurationError();
  }
}

export async function trustedPasswordResetOrigin(env: Env, requestOrigin?: string): Promise<string> {
  const result = await env.DB.prepare(
    `SELECT admin_api_url FROM instances WHERE status = 'active' LIMIT 2`,
  ).all<{ admin_api_url: string }>();
  if (result.results.length !== 1) throw configurationError();
  const origin = result.results[0].admin_api_url;
  if (requestOrigin !== undefined && origin !== requestOrigin) throw configurationError();
  return origin;
}

/** Atomic fixed-window counters; keys contain neither plaintext emails nor IPs. */
export async function takeIdentityRequestAllowance(env: Env, key: string, maximum: number, windowMs: number, now: Date): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO identity_request_limits (key_hash, request_count, expires_at)
     VALUES (?1, 1, ?2)
     ON CONFLICT(key_hash) DO UPDATE SET
       request_count = CASE WHEN expires_at <= ?3 THEN 1 ELSE request_count + 1 END,
       expires_at = CASE WHEN expires_at <= ?3 THEN ?2 ELSE expires_at END
     WHERE expires_at <= ?3 OR request_count < ?4
     RETURNING key_hash`,
  ).bind(await sha256Hex(key), new Date(now.getTime() + windowMs).toISOString(), now.toISOString(), maximum)
    .all<{ key_hash: string }>();
  return result.results.length === 1;
}

export async function requestPasswordReset(input: {
  env: Env; email: string; adminOrigin: string; request: RequestDetails;
}): Promise<string | null> {
  const { env, adminOrigin, request } = input;
  const now = new Date();
  const email = input.email.trim().toLowerCase();
  // Repeated requests receive the same accepted response without generating mail.
  if (!(await takeIdentityRequestAllowance(env, `password-reset:ip:${request.ip ?? "unknown"}`, 10, 600_000, now))) return null;
  if (!(await takeIdentityRequestAllowance(env, `password-reset:email:${email}`, 1, 60_000, now))) return null;
  const users = await env.DB.prepare(
    `SELECT id, password_hash FROM users WHERE email = ?1 COLLATE NOCASE LIMIT 1`,
  ).bind(email).all<{ id: string; password_hash: string }>();
  const user = users.results[0];
  if (!user) return null;
  const id = `prr_${ulid().toLowerCase()}`;
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS).toISOString();
  const link = await prepareOneTimeLink({
    tokenPrefix: "prk", trustedUrl: adminOrigin, path: "/admin/reset-password", environment: env.ENVIRONMENT,
  });
  const ciphertext = await encryptEnvelopeV1(link.url, env, {
    scope: "identity", table: "password_reset_requests", rowId: id, field: "link_ciphertext",
  });
  const nowIso = now.toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE password_reset_requests SET revoked_at = ?1, link_ciphertext = NULL,
         password_hash_at_request = '', send_status = 'cancelled'
       WHERE user_id = ?2 AND consumed_at IS NULL AND revoked_at IS NULL`,
    ).bind(nowIso, user.id),
    env.DB.prepare(
      `INSERT INTO password_reset_requests
       (id, user_id, token_hash, password_hash_at_request, admin_origin, link_ciphertext, expires_at,
        send_status, attempt_count, next_attempt_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0, ?8, ?8)`,
    ).bind(id, user.id, link.tokenHash, user.password_hash, adminOrigin, ciphertext, expiresAt, nowIso),
    prepareAuditInsert({
      db: env.DB, scopeType: "identity", actor: { type: "user", id: user.id },
      action: "identity.password_reset.requested", resourceType: "password_reset_request", resourceId: id,
      ...request, now: nowIso,
    }),
  ]);
  return id;
}

export async function consumePasswordReset(input: {
  env: Env; token: string; newPassword: string; adminOrigin: string; request: RequestDetails;
}): Promise<void> {
  const { env, request } = input;
  const result = await env.DB.prepare(
    `SELECT id, user_id FROM password_reset_requests
     WHERE token_hash = ?1 AND admin_origin = ?2 AND consumed_at IS NULL AND revoked_at IS NULL
       AND expires_at > ?3 LIMIT 1`,
  ).bind(await hashOneTimeLinkToken(input.token), input.adminOrigin, new Date().toISOString())
    .all<{ id: string; user_id: string }>();
  const reset = result.results[0];
  if (!reset) throw invalidLink();
  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      // The database trigger rechecks expiry, previous password, and single use
      // inside this transaction, before any password or session can change.
      env.DB.prepare(
        `UPDATE password_reset_requests SET consumed_at = ?1, link_ciphertext = NULL,
           password_hash_at_request = '' WHERE id = ?2`,
      ).bind(now, reset.id),
      env.DB.prepare(`UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3`)
        .bind(passwordHash, now, reset.user_id),
      env.DB.prepare(`UPDATE admin_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL`)
        .bind(now, reset.user_id),
      prepareAuditInsert({
        db: env.DB, scopeType: "identity", actor: { type: "user", id: reset.user_id },
        action: "identity.password.reset", resourceType: "user", resourceId: reset.user_id,
        details: { all_sessions_revoked: true }, ...request, now,
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("PASSWORD_RESET_LINK_INVALID")) throw invalidLink();
    throw error;
  }
}

function invalidLink(): AppError {
  return new AppError("PASSWORD_RESET_LINK_INVALID", "This password reset link is invalid or expired. Request a new link.", 400);
}

/** A reset request owns its mail state; account mail never enters Instance Delivery. */
export async function dispatchPasswordReset(env: Env, id: string, now = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  const leaseId = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE password_reset_requests SET send_status = 'processing', lease_id = ?1,
       locked_until = ?2, attempt_count = attempt_count + 1
     WHERE id = ?3 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?4
       AND link_ciphertext IS NOT NULL AND attempt_count < ?5
       AND ((send_status = 'pending' AND next_attempt_at <= ?4)
         OR (send_status = 'processing' AND locked_until <= ?4))
     RETURNING id, user_id, admin_origin, link_ciphertext, expires_at, attempt_count`,
  ).bind(leaseId, new Date(now.getTime() + 60_000).toISOString(), id, nowIso, MAX_SEND_ATTEMPTS)
    .all<{ id: string; user_id: string; admin_origin: string; link_ciphertext: string; expires_at: string; attempt_count: number }>();
  const row = claimed.results[0];
  if (!row) return;
  let sent: { providerMessageId: string };
  try {
    const config = passwordResetEmailConfiguration(env);
    const users = await env.DB.prepare(
      `SELECT user.email FROM users AS user JOIN password_reset_requests AS reset ON reset.user_id = user.id
       WHERE reset.id = ?1 AND reset.password_hash_at_request = user.password_hash
         AND reset.revoked_at IS NULL AND reset.consumed_at IS NULL LIMIT 1`,
    ).bind(id).all<{ email: string }>();
    if (!users.results[0]) {
      await env.DB.prepare(
        `UPDATE password_reset_requests SET send_status = 'cancelled', revoked_at = ?1, link_ciphertext = NULL,
           password_hash_at_request = ''
         WHERE id = ?2 AND lease_id = ?3`,
      ).bind(nowIso, id, leaseId).run();
      return;
    }
    const resetUrl = await decryptEnvelopeV1(row.link_ciphertext, env, {
      scope: "identity", table: "password_reset_requests", rowId: id, field: "link_ciphertext",
    });
    // Encrypted payloads remain bound to the configured deployment and exact landing path.
    const parsed = new URL(resetUrl);
    if (parsed.origin !== row.admin_origin || parsed.pathname !== "/admin/reset-password") throw configurationError();
    sent = await config.adapter.send({
      credential: config.credential, from: config.from, to: users.results[0].email,
      templateRef: config.templateRef, variables: { reset_url: resetUrl, expires_at: row.expires_at },
      idempotencyKey: `password-reset:${id}`,
    });
  } catch (error) {
    const classification = getEmailProviderAdapter("resend").classifyError(error);
    const retry = classification.action === "retry" && row.attempt_count < MAX_SEND_ATTEMPTS;
    const code = error instanceof AppError ? error.code : `PASSWORD_RESET_EMAIL_${classification.failureClass.toUpperCase()}`;
    await env.DB.prepare(
      `UPDATE password_reset_requests SET send_status = ?1, next_attempt_at = ?2,
         last_error_code = ?3, locked_until = NULL,
         link_ciphertext = CASE WHEN ?1 = 'failed' THEN NULL ELSE link_ciphertext END
       WHERE id = ?4 AND lease_id = ?5 AND send_status = 'processing'`,
    ).bind(retry ? "pending" : "failed", new Date(now.getTime() + 60_000 * 2 ** (row.attempt_count - 1)).toISOString(), code, id, leaseId).run();
    // Expected delivery failures are persisted and visible to deployment operators.
    // Never log provider text, recipient, URL, credentials, or the caught exception.
    console.error(JSON.stringify({ event: "identity.password_reset.email_failed", request_id: id, code,
      http_status: classification.httpStatus ?? null, retry_scheduled: retry }));
    return;
  }
  await env.DB.prepare(
    `UPDATE password_reset_requests SET send_status = 'accepted', provider_message_id = ?1,
       link_ciphertext = NULL, locked_until = NULL, last_error_code = NULL
     WHERE id = ?2 AND lease_id = ?3 AND send_status = 'processing'`,
  ).bind(sent.providerMessageId, id, leaseId).run();
}

export async function runPasswordResetScheduler(env: Env, now = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE password_reset_requests SET link_ciphertext = NULL, password_hash_at_request = '',
         send_status = CASE WHEN send_status IN ('pending', 'processing') THEN 'expired' ELSE send_status END
       WHERE id IN (SELECT id FROM password_reset_requests WHERE expires_at <= ?1
         AND (link_ciphertext IS NOT NULL OR password_hash_at_request <> '') ORDER BY expires_at LIMIT 100)`,
    ).bind(nowIso),
    env.DB.prepare(
      `DELETE FROM identity_request_limits WHERE key_hash IN
       (SELECT key_hash FROM identity_request_limits WHERE expires_at <= ?1 ORDER BY expires_at LIMIT 500)`,
    ).bind(nowIso),
  ]);
  const due = await env.DB.prepare(
    `SELECT id FROM password_reset_requests WHERE consumed_at IS NULL AND revoked_at IS NULL
       AND expires_at > ?1 AND link_ciphertext IS NOT NULL
       AND ((send_status = 'pending' AND next_attempt_at <= ?1)
         OR (send_status = 'processing' AND locked_until <= ?1))
     ORDER BY next_attempt_at LIMIT 25`,
  ).bind(nowIso).all<{ id: string }>();
  for (const row of due.results) await dispatchPasswordReset(env, row.id, now);
}
