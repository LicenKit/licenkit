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
import {
  prepareEmailNotificationDelivery,
  validateEmailDeliveryConfiguration,
} from "../services/delivery/outbox";
import { dispatchDelivery } from "../infra/delivery/dispatcher";
import { buildCustomerPortalAccessUrl } from "../domain/email/contracts";
import { prepareAuditInsert } from "../services/identity/audit";
import { verifyCustomerMagicLinkTurnstile } from "../services/identity/turnstile";
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
  turnstileToken: z.string().trim().min(1).max(2048),
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

interface CustomerAuthRuntimeEnv {
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  CUSTOMER_MAGIC_LINK_TTL_SECONDS?: string | number;
  CUSTOMER_MAGIC_LINK_COOLDOWN_SECONDS?: string | number;
}

function runtimeEnv(c: { env: unknown }): CustomerAuthRuntimeEnv {
  return c.env as CustomerAuthRuntimeEnv;
}

customerAuthRouter.get("/config", (c) => {
  c.header("Cache-Control", "no-store");
  const turnstileSiteKey = runtimeEnv(c).TURNSTILE_SITE_KEY?.trim();
  if (!turnstileSiteKey || turnstileSiteKey.startsWith("replace-with-")) {
    throw new AppError(
      "TURNSTILE_CONFIGURATION_ERROR",
      "Turnstile is not configured for Customer authentication",
      503,
    );
  }
  return c.json({ success: true, data: { turnstileSiteKey } });
});

customerAuthRouter.post(
  "/magic-link",
  requireExactOrigin,
  async (c) => {
    const startedAt = Date.now();
    const input = MagicLinkRequestSchema.parse(await c.req.json());
    const email = input.email.trim().toLowerCase();
    const ip = requestIp(c) ?? "unknown";
    const settingsResult = await c.env.DB
      .prepare(`SELECT site_url FROM system_settings WHERE id = 'current' LIMIT 1`)
      .all<{ site_url: string }>();
    const siteUrl = settingsResult.results[0]?.site_url;
    if (!siteUrl) {
      throw new AppError("SETUP_REQUIRED", "LicenKit setup has not completed", 503);
    }
    await verifyCustomerMagicLinkTurnstile({
      env: runtimeEnv(c),
      token: input.turnstileToken,
      expectedHostname: new URL(siteUrl).hostname,
      remoteIp: requestIp(c),
    });
    // Fail for every caller before identity lookup when sensitive payload encryption is unavailable.
    getStorageEncryptionKey(c.env);
    const now = new Date();
    const ttlSeconds = positiveIntegerSetting(
      runtimeEnv(c).CUSTOMER_MAGIC_LINK_TTL_SECONDS,
      900,
      "CUSTOMER_MAGIC_LINK_TTL_SECONDS",
    );
    const cooldownSeconds = positiveIntegerSetting(
      runtimeEnv(c).CUSTOMER_MAGIC_LINK_COOLDOWN_SECONDS,
      60,
      "CUSTOMER_MAGIC_LINK_COOLDOWN_SECONDS",
    );

    const accountResult = await c.env.DB
      .prepare(
        `SELECT id, slug
         FROM accounts
         WHERE slug = ?1 AND status = 'active'
         LIMIT 1`,
      )
      .bind(input.accountSlug)
      .all<{ id: string; slug: string }>();
    const account = accountResult.results[0];
    if (account) {
      // Validate shared Provider crypto before looking up the private email so
      // a broken Integration cannot turn the public response into an oracle.
      await validateEmailDeliveryConfiguration({
        db: c.env.DB,
        env: c.env,
        accountId: account.id,
        notificationType: "customer.portal_access_requested",
        contractVersion: 1,
      });
    }

    // Register immediate dispatch when the runtime provides an ExecutionContext.
    // Every environment keeps the same Outbox + Scheduler fallback when it does not.
    let executionContext: { waitUntil(promise: Promise<unknown>): void } | undefined;
    try {
      executionContext = c.executionCtx;
    } catch {
      executionContext = undefined;
    }

    const customerResult = account
      ? await c.env.DB
        .prepare(
          `SELECT id AS customer_id, email
           FROM customers
           WHERE account_id = ?1 AND email = ?2 COLLATE NOCASE
             AND status = 'active'
           LIMIT 1`,
        )
        .bind(account.id, email)
        .all<{ customer_id: string; email: string }>()
      : null;
    const customer = customerResult?.results[0];
    if (account && customer) {
      const nowIso = now.toISOString();
      const cooldownCutoff = new Date(now.getTime() - cooldownSeconds * 1000).toISOString();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      const challengeId = `clg_${ulid().toLowerCase()}`;
      const token = randomToken("mlk");
      const tokenHash = await sha256Hex(token);
      const accessUrl = buildCustomerPortalAccessUrl({
        trustedSiteUrl: siteUrl,
        accountSlug: account.slug,
        oneTimeToken: token,
      });
      const delivery = await prepareEmailNotificationDelivery({
        db: c.env.DB,
        env: c.env,
        accountId: account.id,
        customerId: customer.customer_id,
        notificationType: "customer.portal_access_requested",
        contractVersion: 1,
        recipientEmail: customer.email,
        variables: { access_url: accessUrl, expires_at: expiresAt },
        sendExpiresAt: expiresAt,
        now,
      });
      const auditId = `aud_${ulid().toLowerCase()}`;
      const statements = [
        ...delivery.statements,
        c.env.DB
          .prepare(
            `INSERT INTO customer_login_challenges (
               id, account_id, customer_id, token_hash, expires_at,
               delivery_id, requested_ip, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
             WHERE NOT EXISTS (
               SELECT 1 FROM customer_login_challenges
               WHERE account_id = ?2 AND customer_id = ?3 AND created_at > ?9
             )`
          )
          .bind(
            challengeId,
            account.id,
            customer.customer_id,
            tokenHash,
            expiresAt,
            delivery.deliveryId,
            ip.slice(0, 45),
            nowIso,
            cooldownCutoff,
          ),
        c.env.DB
          .prepare(
            `UPDATE email_deliveries
             SET send_expires_at = ?1,
                 status = CASE
                   WHEN status = 'processing' AND locked_until > ?1 THEN status
                   ELSE 'expired'
                 END,
                 variables_ciphertext = CASE
                   WHEN status = 'processing' AND locked_until > ?1 THEN variables_ciphertext
                   ELSE NULL
                 END,
                 next_attempt_at = CASE
                   WHEN status = 'processing' AND locked_until > ?1 THEN next_attempt_at
                   ELSE NULL
                 END,
                 locked_by = CASE
                   WHEN status = 'processing' AND locked_until > ?1 THEN locked_by
                   ELSE NULL
                 END,
                 locked_until = CASE
                   WHEN status = 'processing' AND locked_until > ?1 THEN locked_until
                   ELSE NULL
                 END,
                 updated_at = ?1
             WHERE account_id = ?2
               AND id IN (
                 SELECT delivery_id FROM customer_login_challenges
                 WHERE account_id = ?2 AND customer_id = ?3
                   AND id <> ?4
                   AND consumed_at IS NULL AND revoked_at IS NULL
               )
               AND EXISTS (
                 SELECT 1 FROM customer_login_challenges
                 WHERE account_id = ?2 AND id = ?4
               )
               AND status NOT IN ('accepted', 'expired', 'cancelled')`
          )
          .bind(nowIso, account.id, customer.customer_id, challengeId),
        c.env.DB
          .prepare(
            `UPDATE customer_login_challenges SET revoked_at = ?1
             WHERE account_id = ?2 AND customer_id = ?3
               AND id <> ?4
               AND consumed_at IS NULL AND revoked_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM customer_login_challenges AS created_challenge
                 WHERE created_challenge.account_id = ?2 AND created_challenge.id = ?4
               )`
          )
          .bind(nowIso, account.id, customer.customer_id, challengeId),
        c.env.DB
          .prepare(
            `INSERT INTO audit_logs (
               id, account_id, actor_type, actor_user_id, actor_customer_id,
               action, resource_type, resource_id, request_id,
               details_redacted_json, ip, user_agent, created_at
             )
             SELECT ?1, ?2, 'system', NULL, NULL,
                    'customer.magic_link.requested', 'customer_login_challenge', ?3, NULL,
                    ?4, ?5, ?6, ?7
             WHERE EXISTS (
               SELECT 1 FROM customer_login_challenges
               WHERE account_id = ?2 AND id = ?3
             )`
          )
          .bind(
            auditId,
            account.id,
            challengeId,
            JSON.stringify({
              customerId: customer.customer_id,
              deliveryId: delivery.deliveryId,
              deliveryStatus: delivery.status,
            }),
            ip.slice(0, 45),
            c.req.header("user-agent")?.slice(0, 255) ?? null,
            nowIso,
          ),
        c.env.DB
          .prepare(
            `DELETE FROM email_deliveries
             WHERE account_id = ?1 AND id = ?2
               AND NOT EXISTS (
                 SELECT 1 FROM customer_login_challenges
                 WHERE account_id = ?1 AND delivery_id = ?2
               )`
          )
          .bind(account.id, delivery.deliveryId),
      ];
      const batchResults = await c.env.DB.batch(statements);
      const challengeInserted = Number(
        batchResults[delivery.statements.length]?.meta?.changes ?? 0,
      ) === 1;
      if (challengeInserted && delivery.status === "pending" && executionContext) {
        executionContext.waitUntil(dispatchDelivery({
          db: c.env.DB,
          env: c.env,
          accountId: account.id,
          deliveryId: delivery.deliveryId,
          workerId: `email_http_${ulid().toLowerCase()}`,
        }).then(() => undefined));
      }
    }
    await preserveEnumerationTiming(startedAt);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: { accepted: true } });
  }
);

customerAuthRouter.post(
  "/magic-link/consume",
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
            `UPDATE email_deliveries
             SET send_expires_at = CASE
                   WHEN status IN ('accepted', 'cancelled') THEN send_expires_at
                   ELSE ?1
                 END,
                 status = CASE
                   WHEN status IN ('accepted', 'cancelled') THEN status
                   WHEN status = 'processing' AND locked_until > ?1 THEN status
                   ELSE 'expired'
                 END,
                 variables_ciphertext = CASE
                   WHEN status = 'processing' AND locked_until > ?1 THEN variables_ciphertext
                   ELSE NULL
                 END,
                 next_attempt_at = CASE
                   WHEN status = 'processing' AND locked_until > ?1 THEN next_attempt_at
                   ELSE NULL
                 END,
                 locked_by = CASE
                   WHEN status = 'processing' AND locked_until > ?1 THEN locked_by
                   ELSE NULL
                 END,
                 locked_until = CASE
                   WHEN status = 'processing' AND locked_until > ?1 THEN locked_until
                   ELSE NULL
                 END,
                 updated_at = ?1
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
