import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext } from "../types";
import { bufferToBase64, hashPassword, timingSafeEqual } from "../infra/crypto";
import { AppError, UnauthorizedError } from "../middleware/error";
import { requireAdminAppOrigin, setupGuard } from "../middleware/auth";
import {
  isSchemefulSameSite,
  isTrustedUrlProtocolAllowed,
  schemefulSite,
} from "../config/trusted-url";
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
    customer_site_url: z.string().trim().url().max(2048),
    admin_api_url: z.string().trim().url().max(2048),
  }).strict(),
}).strict();

function parseSetupUrl(value: string, environment: string | undefined, code: string, label: string): URL {
  const url = new URL(value);
  if (!isTrustedUrlProtocolAllowed(url, environment)) {
    throw new AppError(
      code,
      `${label} must use HTTPS, except for non-production localhost or 127.0.0.1 HTTP`,
      400,
      { protocol: url.protocol, hostname: url.hostname },
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(
      code,
      `${label} cannot contain credentials, query parameters, or a fragment`,
      400,
    );
  }
  return url;
}

function normalizeAdminApiUrl(
  value: string,
  requestOrigin: string,
  environment: string | undefined,
): string {
  const url = parseSetupUrl(value, environment, "SETUP_ADMIN_API_URL_INVALID", "Admin/API URL");
  if (url.pathname !== "/" || url.origin !== value) {
    throw new AppError(
      "SETUP_ADMIN_API_URL_INVALID",
      "Admin/API URL must be an exact Origin without a path or trailing slash",
      400,
      { adminApiUrl: value, normalizedOrigin: url.origin },
    );
  }
  if (url.origin !== requestOrigin) {
    throw new AppError(
      "SETUP_ADMIN_API_URL_ORIGIN_MISMATCH",
      "Admin/API URL must match the Worker Origin used to access Setup",
      400,
      { adminApiOrigin: url.origin, requestOrigin },
    );
  }
  return url.origin;
}

function normalizeCustomerSiteUrl(
  value: string,
  adminApiUrl: string,
  environment: string | undefined,
): string {
  const url = parseSetupUrl(value, environment, "SETUP_CUSTOMER_SITE_URL_INVALID", "Customer Site URL");
  assertCustomerSiteSameSite(url.origin, adminApiUrl);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "" || path === "/" ? "" : path}`;
}

function assertCustomerSiteSameSite(
  customerSiteOrigin: string,
  adminApiOrigin: string,
): void {
  const customerOrigin = new URL(customerSiteOrigin);
  const apiOrigin = new URL(adminApiOrigin);
  if (isSchemefulSameSite(customerOrigin, apiOrigin)) return;

  throw new AppError(
    "SETUP_CUSTOMER_SITE_CROSS_SITE_UNSUPPORTED",
    "Customer Site and LicenKit API must use the same schemeful site for SameSite=Lax Customer cookies",
    400,
    {
      adminApiOrigin,
      customerSiteOrigin,
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

function createInstanceId(): string {
  return bufferToBase64(crypto.getRandomValues(new Uint8Array(16)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
    const requestOrigin = new URL(c.req.url).origin;
    const adminApiUrl = normalizeAdminApiUrl(
      input.instance.admin_api_url,
      requestOrigin,
      c.env.ENVIRONMENT,
    );
    const customerSiteUrl = normalizeCustomerSiteUrl(
      input.instance.customer_site_url,
      adminApiUrl,
      c.env.ENVIRONMENT,
    );
    const instanceId = createInstanceId();
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
          customerSiteUrl,
          adminApiUrl,
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
        details: {
          instance_id: instanceId,
          user_id: userId,
          customer_site_url: customerSiteUrl,
          admin_api_url: adminApiUrl,
        },
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
            customer_site_url: customerSiteUrl,
            admin_api_url: adminApiUrl,
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
