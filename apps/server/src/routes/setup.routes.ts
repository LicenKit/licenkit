import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext } from "../types";
import { hashPassword, timingSafeEqual } from "../infra/crypto";
import { AppError, UnauthorizedError } from "../middleware/error";
import { requireAdminAppOrigin, setupGuard } from "../middleware/auth";
import { customerSiteOrigin } from "../config/customer-site";
import { isSchemefulSameSite, schemefulSite } from "../config/trusted-url";
import {
  prepareInitialDeployment,
  readDeploymentSetupState,
} from "../services/identity/deployment-provisioning";
import {
  createSessionSecrets,
  positiveIntegerSetting,
  requestIp,
  setAdminCookies,
} from "../services/identity/session";
import { prepareAuditInsert } from "../services/identity/audit";

export const setupRouter = new Hono<AppContext>();

const VerifyTokenSchema = z.object({
  setup_token: z.string().min(1),
}).strict();

const SetupSchema = z.object({
  setup_token: z.string().min(1),
  user: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().email().max(320),
    password: z.string().min(12).max(256),
  }).strict(),
  instance: z.object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63),
    site_url: z.string().trim().url().max(2048),
  }).strict(),
}).strict();

function normalizeCustomerSiteUrl(
  value: string,
  configuredCustomerSiteOrigin: string,
  appOrigin: string,
): string {
  const url = new URL(value);
  assertCustomerSiteSameSite(configuredCustomerSiteOrigin, appOrigin);
  if (url.origin !== configuredCustomerSiteOrigin) {
    throw new AppError(
      "SETUP_SITE_URL_ORIGIN_MISMATCH",
      "Site URL must use the configured Customer Site Origin",
      400,
      {
        appOrigin,
        customerSiteOrigin: configuredCustomerSiteOrigin,
        siteOrigin: url.origin,
      },
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

function assertCustomerSiteSameSite(
  configuredCustomerSiteOrigin: string,
  appOrigin: string,
): void {
  const customerOrigin = new URL(configuredCustomerSiteOrigin);
  const apiOrigin = new URL(appOrigin);
  if (isSchemefulSameSite(customerOrigin, apiOrigin)) return;

  throw new AppError(
    "SETUP_CUSTOMER_SITE_CROSS_SITE_UNSUPPORTED",
    "Customer Site and LicenKit API must use the same schemeful site for SameSite=Lax Customer cookies",
    400,
    {
      appOrigin,
      customerSiteOrigin: configuredCustomerSiteOrigin,
      appSite: schemefulSite(apiOrigin),
      customerSite: schemefulSite(customerOrigin),
    },
  );
}

function requireValidSetupToken(configuredValue: string | undefined, submittedValue: string): void {
  const configuredToken = configuredValue?.trim();
  if (!configuredToken) {
    throw new AppError("SETUP_CONFIGURATION_MISSING", "INITIAL_SETUP_TOKEN is not configured", 500);
  }
  if (!timingSafeEqual(submittedValue, configuredToken)) {
    throw new UnauthorizedError("Setup token is invalid");
  }
}

setupRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

setupRouter.get("/status", async (c) => {
  const state = await readDeploymentSetupState(c.env.DB);
  if (state.status === "inconsistent") {
    throw new AppError("SETUP_STATE_INCONSISTENT", "Database initialization state is inconsistent", 500);
  }
  return c.json({ success: true, data: { initialized: state.status === "completed" } });
});

setupRouter.post(
  "/verify-token",
  requireAdminAppOrigin,
  setupGuard,
  async (c) => {
    const input = VerifyTokenSchema.parse(await c.req.json());
    requireValidSetupToken(c.env.INITIAL_SETUP_TOKEN, input.setup_token);
    assertCustomerSiteSameSite(
      customerSiteOrigin(c.env),
      new URL(c.req.url).origin,
    );
    return c.json({ success: true, data: { valid: true } });
  },
);

setupRouter.post(
  "/",
  requireAdminAppOrigin,
  setupGuard,
  async (c) => {
    const input = SetupSchema.parse(await c.req.json());
    requireValidSetupToken(c.env.INITIAL_SETUP_TOKEN, input.setup_token);

    const now = new Date();
    const nowIso = now.toISOString();
    const origin = new URL(c.req.url).origin;
    const siteUrl = normalizeCustomerSiteUrl(
      input.instance.site_url,
      customerSiteOrigin(c.env),
      origin,
    );
    const instanceId = `ins_${ulid().toLowerCase()}`;
    const userId = `usr_${ulid().toLowerCase()}`;
    const sessionId = `ase_${ulid().toLowerCase()}`;
    const email = input.user.email.trim().toLowerCase();
    const [passwordHash, secrets] = await Promise.all([
      hashPassword(input.user.password),
      createSessionSecrets("adm"),
    ]);
    const sessionTtl = positiveIntegerSetting(
      c.env.ADMIN_SESSION_TTL_SECONDS,
      604_800,
      "ADMIN_SESSION_TTL_SECONDS",
    );
    const expiresAt = new Date(now.getTime() + sessionTtl * 1000).toISOString();

    const statements: D1PreparedStatement[] = [
      ...prepareInitialDeployment({
        db: c.env.DB,
        user: { id: userId, name: input.user.name, email, passwordHash },
        instance: {
          id: instanceId,
          name: input.instance.name,
          slug: input.instance.slug,
          siteUrl,
        },
        session: {
          id: sessionId,
          sessionTokenHash: secrets.sessionTokenHash,
          csrfTokenHash: secrets.csrfTokenHash,
          expiresAt,
        },
        now: nowIso,
      }),
      prepareAuditInsert({
        db: c.env.DB,
        scopeType: "instance",
        instanceId,
        actor: { type: "user", id: userId },
        action: "instance.setup_completed",
        resourceType: "instance",
        resourceId: instanceId,
        details: { instance_id: instanceId, user_id: userId, site_url: siteUrl },
        requestId: c.get("requestId"),
        ip: requestIp(c),
        userAgent: c.req.header("user-agent"),
        now: nowIso,
      }),
      c.env.DB
        .prepare(
          `INSERT INTO deployment_bootstrap (singleton_key, completed_at)
           VALUES ('deployment', ?1)`,
        )
        .bind(nowIso),
    ];

    try {
      await c.env.DB.batch(statements);
    } catch (error) {
      try {
        const state = await readDeploymentSetupState(c.env.DB);
        if (state.status === "completed") {
          throw new AppError("SETUP_ALREADY_COMPLETED", "Instance setup has already completed", 409);
        }
      } catch (stateError) {
        if (stateError instanceof AppError && stateError.code === "SETUP_ALREADY_COMPLETED") {
          throw stateError;
        }
      }
      throw error;
    }

    setAdminCookies(c, {
      sessionToken: secrets.sessionToken,
      csrfToken: secrets.csrfToken,
      maxAge: sessionTtl,
    });
    return c.json(
      {
        success: true,
        data: {
          user: { id: userId, name: input.user.name, email },
          instance: {
            id: instanceId,
            name: input.instance.name,
            slug: input.instance.slug,
            site_url: siteUrl,
            status: "active",
          },
          membership: { role: "owner", status: "active" },
          expires_at: expiresAt,
        },
      },
      201,
    );
  },
);
