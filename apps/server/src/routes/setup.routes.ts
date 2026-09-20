import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext } from "../types";
import { hashPassword, timingSafeEqual } from "../infra/crypto";
import { AppError, UnauthorizedError } from "../middleware/error";
import { requireExactOrigin, setupGuard } from "../middleware/auth";
import { prepareAccountWithOwner } from "../services/identity/account-provisioning";
import {
  createSessionSecrets,
  positiveIntegerSetting,
  requestIp,
  setAdminCookies,
} from "../services/identity/session";
import { prepareAuditInsert } from "../services/identity/audit";

export const setupRouter = new Hono<AppContext>();

const SetupSchema = z.object({
  setupToken: z.string().min(1),
  instanceName: z.string().trim().min(1).max(120),
  siteUrl: z.string().trim().url().max(2048),
  accountSlug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63),
  owner: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().email().max(320),
    password: z.string().min(12).max(256),
  }),
});

function normalizeSameOriginSiteUrl(value: string, appOrigin: string): string {
  const url = new URL(value);
  if (url.origin !== appOrigin) {
    throw new AppError(
      "SETUP_SITE_URL_ORIGIN_MISMATCH",
      "Site URL must use the same Origin as the LicenKit app URL",
      400,
      { appOrigin, siteOrigin: url.origin },
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(
      "SETUP_SITE_URL_INVALID",
      "Site URL cannot contain credentials, query parameters, or a fragment",
      400,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "" || path === "/" ? "" : path}`;
}

async function setupCounts(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM system_settings) AS settings_count,
         (SELECT COUNT(*) FROM accounts) AS account_count,
         (SELECT COUNT(*) FROM users) AS user_count`
    )
    .all<{ settings_count: number; account_count: number; user_count: number }>();
  return result.results[0];
}

setupRouter.get("/status", async (c) => {
  const counts = await setupCounts(c.env.DB);
  if (!counts) throw new AppError("SETUP_STATE_UNAVAILABLE", "Setup state could not be read", 500);
  const empty = counts.settings_count === 0 && counts.account_count === 0 && counts.user_count === 0;
  const initialized = counts.settings_count === 1 && counts.account_count > 0 && counts.user_count > 0;
  if (!empty && !initialized) {
    throw new AppError("SETUP_STATE_INCONSISTENT", "Database initialization state is inconsistent", 500);
  }
  return c.json({ success: true, data: { initialized } });
});

setupRouter.post(
  "/",
  requireExactOrigin,
  setupGuard,
  async (c) => {
  const input = SetupSchema.parse(await c.req.json());
  const configuredToken = ((c.env as any).INITIAL_SETUP_TOKEN as string | undefined)?.trim();
  if (!configuredToken) {
    throw new AppError("SETUP_CONFIGURATION_MISSING", "INITIAL_SETUP_TOKEN is not configured", 500);
  }
  if (!timingSafeEqual(input.setupToken, configuredToken)) {
    throw new UnauthorizedError("Setup token is invalid");
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const origin = new URL(c.req.url).origin;
  const siteUrl = normalizeSameOriginSiteUrl(input.siteUrl, origin);
  const accountId = `acc_${ulid().toLowerCase()}`;
  const ownerId = `usr_${ulid().toLowerCase()}`;
  const sessionId = `ase_${ulid().toLowerCase()}`;
  const email = input.owner.email.trim().toLowerCase();
  const [passwordHash, secrets] = await Promise.all([
    hashPassword(input.owner.password),
    createSessionSecrets("adm"),
  ]);
  const sessionTtl = positiveIntegerSetting(
    (c.env as any).ADMIN_SESSION_TTL_SECONDS,
    604_800,
    "ADMIN_SESSION_TTL_SECONDS"
  );
  const expiresAt = new Date(now.getTime() + sessionTtl * 1000).toISOString();

  const statements: D1PreparedStatement[] = [
    c.env.DB
      .prepare(
        `INSERT INTO system_settings (
           id, instance_name, app_url, site_url, api_base_url, initialized_at, updated_at
         ) VALUES ('current', ?1, ?2, ?3, ?4, ?5, ?5)`
      )
      .bind(input.instanceName, origin, siteUrl, `${origin}/api/v1`, nowIso),
    ...prepareAccountWithOwner({
      db: c.env.DB,
      account: { id: accountId, name: input.instanceName, slug: input.accountSlug },
      owner: { id: ownerId, name: input.owner.name, email, passwordHash },
      now: nowIso,
    }),
    c.env.DB
      .prepare(
        `INSERT INTO admin_sessions (
           id, account_id, user_id, session_token_hash, csrf_token_hash,
           expires_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(
        sessionId,
        accountId,
        ownerId,
        secrets.sessionTokenHash,
        secrets.csrfTokenHash,
        expiresAt,
        nowIso
      ),
    prepareAuditInsert({
      db: c.env.DB,
      accountId,
      actor: { type: "user", id: ownerId },
      action: "setup.completed",
      resourceType: "system_settings",
      resourceId: "current",
      details: { accountId, ownerId, siteUrl },
      ip: requestIp(c),
      userAgent: c.req.header("user-agent"),
      now: nowIso,
    }),
  ];

  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    const counts = await setupCounts(c.env.DB);
    if (counts && counts.settings_count > 0) {
      throw new AppError("SETUP_ALREADY_COMPLETED", "Instance setup has already completed", 409);
    }
    throw error;
  }

  setAdminCookies(c, {
    accountId,
    sessionToken: secrets.sessionToken,
    csrfToken: secrets.csrfToken,
    maxAge: sessionTtl,
  });
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      success: true,
      data: {
        account: { id: accountId, name: input.instanceName, slug: input.accountSlug },
        owner: { id: ownerId, name: input.owner.name, email, role: "owner" },
      },
    },
    201
  );
  }
);
