import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppContext, Env } from "./types";
import { errorHandler, AppError } from "./middleware/error";
import {
  adminCsrf,
  adminSessionAuth,
  requireDeclaredAdminPermission,
  requireExactOrigin,
} from "./middleware/auth";
import { requestContext } from "./middleware/request-context";
import { systemRouter } from "./routes/system.routes";
import { setupRouter } from "./routes/setup.routes";
import { adminAuthRouter } from "./routes/auth.routes";
import { clientRouter } from "./routes/client.routes";
import { customerAuthRouter } from "./routes/customer-auth.routes";
import { customerRouter } from "./routes/customer.routes";
import { adminAccountRouter } from "./routes/admin/settings.routes";
import { adminUsersRouter } from "./routes/admin/users.routes";
import { adminProductsRouter } from "./routes/admin/products.routes";
import { adminLicensePlansRouter } from "./routes/admin/license-plans.routes";
import { adminLicensesRouter } from "./routes/admin/licenses.routes";
import { adminBillingRouter } from "./routes/admin/billing.routes";
import { adminCustomersRouter } from "./routes/customer-admin.routes";
import { adminStatsRouter } from "./routes/admin/stats.routes";
import { adminAuditRouter } from "./routes/admin/audit.routes";
import { adminSystemIssuesRouter } from "./routes/admin/system-issues.routes";
import {
  adminEmailIntegrationsRouter,
  adminEmailDeliveriesRouter,
  adminEmailTemplateContractsRouter,
} from "./routes/admin/email.routes";
import { webhookRouter } from "./routes/webhook.routes";
import { processDueBillingInboundEvents } from "./services/billing/fulfillment";
import { runDeliveryScheduler } from "./services/delivery/scheduler";
import { clearExpiredAcceptedEmailPayloads } from "./services/delivery/retention";
import { recordSchedulerSuccess } from "./services/runtime/scheduler-health";
import { clearExpiredInboundEventPayloads } from "./services/runtime/retention";

const app = new Hono<AppContext>();
app.onError(errorHandler);
app.use("*", requestContext);

app.use("*", async (c, next) => {
  const middleware = cors({
    origin: (origin) => {
      if (!origin) return "";
      if (
        c.env.ENVIRONMENT !== "production" &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        return origin;
      }
      return "";
    },
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
      "X-Request-Id",
      "Paddle-Signature",
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Request-Id"],
    maxAge: 600,
    credentials: true,
  });
  await middleware(c, next);
});

const api = new Hono<AppContext>();

api.route("/setup", setupRouter);
api.route("/system", systemRouter);

api.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/v1/setup") || c.req.path === "/api/v1/system/status") {
    await next();
    return;
  }
  const initialized = await c.env.DB
    .prepare(`SELECT id FROM system_settings WHERE id = 'current' LIMIT 1`)
    .first<{ id: string }>();
  if (!initialized) {
    throw new AppError("SETUP_REQUIRED", "LicenKit setup has not completed.", 503);
  }
  await next();
});

api.route("/admin/auth", adminAuthRouter);
api.route("/client", clientRouter);
api.route("/customer/auth", customerAuthRouter);
api.route("/customer", customerRouter);
api.route("/webhooks", webhookRouter);

const admin = new Hono<AppContext>();
admin.use("*", adminSessionAuth);
admin.use("*", requireDeclaredAdminPermission);
admin.use("*", async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    await next();
    return;
  }
  await requireExactOrigin(c, async () => {
    await adminCsrf(c, async () => {
      await next();
    });
  });
});
admin.route("/account", adminAccountRouter);
admin.route("/users", adminUsersRouter);
admin.route("/products", adminProductsRouter);
admin.route("/license-plans", adminLicensePlansRouter);
admin.route("/licenses", adminLicensesRouter);
admin.route("/billing", adminBillingRouter);
admin.route("/customers", adminCustomersRouter);
admin.route("/stats", adminStatsRouter);
admin.route("/audit-logs", adminAuditRouter);
admin.route("/system", adminSystemIssuesRouter);
admin.route("/email-template-contracts", adminEmailTemplateContractsRouter);
admin.route("/email-integrations", adminEmailIntegrationsRouter);
admin.route("/email-deliveries", adminEmailDeliveriesRouter);
api.route("/admin", admin);

app.route("/api/v1", api);

app.get("/", (c) => c.redirect("/admin/", 302));
app.all("/admin", (c) => c.redirect("/admin/", 302));
app.all("/admin/*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("LicenKit Admin assets are not configured.", 404);
});
app.all("*", (c) => c.text("Not Found", 404));

export { app };
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const startedAt = Date.now();
    ctx.waitUntil(
      (async () => {
        await Promise.all([
          processDueBillingInboundEvents(env),
          runDeliveryScheduler(env),
        ]);
        await Promise.all([
          clearExpiredInboundEventPayloads(env.DB),
          clearExpiredAcceptedEmailPayloads(env.DB),
        ]);
        await recordSchedulerSuccess(env.DB, startedAt);
      })(),
    );
  },
};
