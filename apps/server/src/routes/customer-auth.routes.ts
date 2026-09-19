import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext } from "../types";
import { bufferToHex, getStorageEncryptionKey, sha256Hex } from "../infra/crypto";
import { AppError } from "../middleware/error";
import {
  customerCsrf,
  customerSessionAuth,
  requireExactOrigin,
} from "../middleware/auth";
import { consumeRateLimit, rateLimit } from "../middleware/rate-limit";
import { prepareNotificationDelivery } from "../services/delivery/outbox";
import { prepareAuditInsert } from "../services/identity/audit";
import {
  clearCustomerCookies,
  createSessionSecrets,
  positiveIntegerSetting,
  requestIp,
  setCustomerCookies,
} from "../services/identity/session";

export const customerAuthRouter = new Hono<AppContext>();

const MagicLinkRequestSchema = z.object({
  accountSlug: z.string().trim().toLowerCase().min(1).max(63),
  email: z.string().email().max(320),
});
const ConsumeSchema = z.object({
  accountSlug: z.string().trim().toLowerCase().min(1).max(63),
  token: z.string().min(32).max(256),
});

function randomToken(prefix: string): string {
  return `${prefix}_${bufferToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function preserveEnumerationTiming(startedAt: number): Promise<void> {
  const jitter = crypto.getRandomValues(new Uint8Array(1))[0] % 26;
  const remaining = 175 + jitter - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

customerAuthRouter.post(
  "/magic-link",
  rateLimit({ limit: 30, windowSeconds: 900, keyPrefix: "customer_magic_link_ip" }),
  requireExactOrigin,
  async (c) => {
    const startedAt = Date.now();
    const input = MagicLinkRequestSchema.parse(await c.req.json());
    const email = input.email.trim().toLowerCase();
    const ip = requestIp(c) ?? "unknown";
    const emailHash = await sha256Hex(email);
    const ipHash = await sha256Hex(ip);
    await consumeRateLimit(
      c.env.KEYS_KV,
      `rl:customer_magic_link_identity:${input.accountSlug}:${emailHash}:${ipHash}`,
      { limit: 5, windowSeconds: 900, message: "Too many Magic Link requests" },
    );
    // Fail for every caller before identity lookup when sensitive payload encryption is unavailable.
    getStorageEncryptionKey(c.env);

    const customerResult = await c.env.DB
      .prepare(
        `SELECT a.id AS account_id, a.slug AS account_slug, c.id AS customer_id,
                c.email, s.app_url
         FROM accounts AS a
         JOIN customers AS c ON c.account_id = a.id
         JOIN system_settings AS s ON s.id = 'current'
         WHERE a.slug = ?1 AND a.status = 'active'
           AND c.email = ?2 COLLATE NOCASE AND c.status = 'active'
         LIMIT 1`
      )
      .bind(input.accountSlug, email)
      .all<any>();
    const customer = customerResult.results[0];
    if (customer) {
      const now = new Date();
      const nowIso = now.toISOString();
      const ttlSeconds = positiveIntegerSetting(
        (c.env as any).CUSTOMER_MAGIC_LINK_TTL_SECONDS,
        900,
        "CUSTOMER_MAGIC_LINK_TTL_SECONDS"
      );
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      const challengeId = `clg_${ulid().toLowerCase()}`;
      const token = randomToken("mlk");
      const tokenHash = await sha256Hex(token);
      const baseUrl = String(customer.app_url).replace(/\/+$/, "");
      const accessUrl = `${baseUrl}/customer/${encodeURIComponent(customer.account_slug)}/auth#token=${encodeURIComponent(token)}`;
      const delivery = await prepareNotificationDelivery({
        db: c.env.DB,
        env: c.env as any,
        accountId: customer.account_id,
        customerId: customer.customer_id,
        eventType: "customer.portal_access_requested",
        recipientEmail: customer.email,
        payload: { customer_id: customer.customer_id, access_url: accessUrl, expires_at: expiresAt },
        payloadExpiresAt: expiresAt,
        idempotencyKey: `customer.portal_access_requested:${challengeId}`,
        now,
      });
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            `UPDATE outbound_deliveries
             SET status = 'payload_expired', payload_ciphertext = NULL,
                 payload_cleared_at = ?1, next_attempt_at = NULL, updated_at = ?1
             WHERE account_id = ?2
               AND id IN (
                 SELECT delivery_id FROM customer_login_challenges
                 WHERE account_id = ?2 AND customer_id = ?3
                   AND consumed_at IS NULL AND revoked_at IS NULL
               )
               AND status NOT IN ('accepted', 'payload_expired')`
          )
          .bind(nowIso, customer.account_id, customer.customer_id),
        c.env.DB
          .prepare(
            `UPDATE customer_login_challenges SET revoked_at = ?1
             WHERE account_id = ?2 AND customer_id = ?3
               AND consumed_at IS NULL AND revoked_at IS NULL`
          )
          .bind(nowIso, customer.account_id, customer.customer_id),
        ...delivery.statements,
        c.env.DB
          .prepare(
            `INSERT INTO customer_login_challenges (
               id, account_id, customer_id, token_hash, expires_at,
               delivery_id, requested_ip, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
          )
          .bind(
            challengeId,
            customer.account_id,
            customer.customer_id,
            tokenHash,
            expiresAt,
            delivery.deliveryId,
            ip,
            nowIso
          ),
        prepareAuditInsert({
          db: c.env.DB,
          accountId: customer.account_id,
          actor: { type: "system" },
          action: "customer.magic_link.requested",
          resourceType: "customer_login_challenge",
          resourceId: challengeId,
          details: { customerId: customer.customer_id, deliveryId: delivery.deliveryId, deliveryStatus: delivery.status },
          ip,
          userAgent: c.req.header("user-agent"),
          now: nowIso,
        }),
      ]);
    }
    await preserveEnumerationTiming(startedAt);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: { accepted: true } });
  }
);

customerAuthRouter.post(
  "/magic-link/consume",
  rateLimit({ limit: 20, windowSeconds: 900, keyPrefix: "customer_magic_link_consume" }),
  requireExactOrigin,
  async (c) => {
    const input = ConsumeSchema.parse(await c.req.json());
    const tokenHash = await sha256Hex(input.token);
    const now = new Date();
    const nowIso = now.toISOString();
    const candidateResult = await c.env.DB
      .prepare(
        `SELECT a.id AS account_id, ch.id AS challenge_id, ch.customer_id, ch.delivery_id
         FROM accounts AS a
         JOIN customer_login_challenges AS ch ON ch.account_id = a.id
         JOIN customers AS customer ON customer.account_id = ch.account_id AND customer.id = ch.customer_id
         WHERE a.slug = ?1 AND a.status = 'active'
           AND ch.token_hash = ?2 AND ch.consumed_at IS NULL AND ch.revoked_at IS NULL
           AND ch.expires_at > ?3 AND customer.status = 'active'
         LIMIT 1`
      )
      .bind(input.accountSlug, tokenHash, nowIso)
      .all<any>();
    const candidate = candidateResult.results[0];
    if (!candidate) {
      throw new AppError("CUSTOMER_MAGIC_LINK_INVALID", "Magic Link is invalid or expired", 400);
    }
    const ttlSeconds = positiveIntegerSetting(
      (c.env as any).CUSTOMER_SESSION_TTL_SECONDS,
      604_800,
      "CUSTOMER_SESSION_TTL_SECONDS"
    );
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const sessionId = `cse_${ulid().toLowerCase()}`;
    const secrets = await createSessionSecrets("cus");
    let rawResults: unknown[];
    try {
      rawResults = await c.env.DB.batch([
        c.env.DB
          .prepare(
            `INSERT INTO customer_sessions (
               id, account_id, customer_id, login_challenge_id,
               session_token_hash, csrf_token_hash, expires_at, created_at
             )
             SELECT ?1, ch.account_id, ch.customer_id, ch.id, ?2, ?3, ?4, ?5
             FROM customer_login_challenges AS ch
             JOIN customers AS customer ON customer.account_id = ch.account_id AND customer.id = ch.customer_id
             WHERE ch.account_id = ?6 AND ch.token_hash = ?7
               AND ch.consumed_at IS NULL AND ch.revoked_at IS NULL AND ch.expires_at > ?5
               AND customer.status = 'active'`
          )
          .bind(
            sessionId,
            secrets.sessionTokenHash,
            secrets.csrfTokenHash,
            expiresAt,
            nowIso,
            candidate.account_id,
            tokenHash
          ),
        c.env.DB
          .prepare(
            `UPDATE customer_login_challenges SET consumed_at = ?1
             WHERE account_id = ?2 AND token_hash = ?3
               AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?1
               AND EXISTS (
                 SELECT 1 FROM customer_sessions
                 WHERE account_id = ?2 AND login_challenge_id = customer_login_challenges.id AND id = ?4
               )`
          )
          .bind(nowIso, candidate.account_id, tokenHash, sessionId),
        c.env.DB
          .prepare(
            `UPDATE outbound_deliveries
             SET status = CASE WHEN status = 'accepted' THEN status ELSE 'payload_expired' END,
                 payload_ciphertext = NULL, payload_cleared_at = COALESCE(payload_cleared_at, ?1),
                 next_attempt_at = NULL, updated_at = ?1
             WHERE account_id = ?2 AND id = ?3`
          )
          .bind(nowIso, candidate.account_id, candidate.delivery_id),
        prepareAuditInsert({
          db: c.env.DB,
          accountId: candidate.account_id,
          actor: { type: "customer", id: candidate.customer_id },
          action: "customer.magic_link.consumed",
          resourceType: "customer_session",
          resourceId: sessionId,
          details: { challengeId: candidate.challenge_id },
          ip: requestIp(c),
          userAgent: c.req.header("user-agent"),
          now: nowIso,
        }),
      ]);
      rawResults = await Promise.all(rawResults as Promise<unknown>[]);
    } catch (error) {
      throw new AppError(
        "CUSTOMER_MAGIC_LINK_CONSUME_FAILED",
        "Magic Link could not be consumed because the session transaction failed",
        500,
        undefined,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const inserted = Number((rawResults[0] as any)?.meta?.changes ?? 0);
    if (inserted !== 1) {
      throw new AppError("CUSTOMER_MAGIC_LINK_INVALID", "Magic Link is invalid or expired", 400);
    }
    setCustomerCookies(c, {
      accountId: candidate.account_id,
      sessionToken: secrets.sessionToken,
      csrfToken: secrets.csrfToken,
      maxAge: ttlSeconds,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: { authenticated: true, expiresAt } });
  }
);

customerAuthRouter.post(
  "/logout",
  customerSessionAuth,
  requireExactOrigin,
  customerCsrf,
  async (c) => {
    const accountId = c.get("accountId")!;
    const customerId = (c as any).get("customerId") as string;
    const sessionId = (c as any).get("customerSessionId") as string;
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE customer_sessions SET revoked_at = ?1
           WHERE account_id = ?2 AND customer_id = ?3 AND id = ?4 AND revoked_at IS NULL`
        )
        .bind(now, accountId, customerId, sessionId),
      prepareAuditInsert({
        db: c.env.DB,
        accountId,
        actor: { type: "customer", id: customerId },
        action: "customer.auth.logout",
        resourceType: "customer_session",
        resourceId: sessionId,
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now,
      }),
    ]);
    clearCustomerCookies(c);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: { loggedOut: true } });
  }
);
