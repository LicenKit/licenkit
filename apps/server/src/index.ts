import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppContext, Env } from "./types";
import { errorHandler } from "./middleware/error";
import { sessionAuth } from "./middleware/auth";
import { systemRouter } from "./routes/system.routes";
import { authRouter } from "./routes/auth.routes";
import { clientRouter } from "./routes/client.routes";
import { adminSettingsRouter } from "./routes/admin/settings.routes";
import { adminUsersRouter } from "./routes/admin/users.routes";
import { adminProductsRouter } from "./routes/admin/products.routes";
import { adminPoliciesRouter } from "./routes/admin/policies.routes";
import { adminLicensesRouter } from "./routes/admin/licenses.routes";
import { adminWebhooksRouter } from "./routes/admin/webhooks.routes";
import { adminStatsRouter } from "./routes/admin/stats.routes";
import { adminAuditRouter } from "./routes/admin/audit.routes";
import { webhookRouter } from "./routes/webhook.routes";
import { handleQueueBatch, type WebhookMessage } from "./queue/consumer";

const app = new Hono<AppContext>();

// Global Error Handler
app.onError(errorHandler);

// Global CORS Configuration
app.use(
  "*",
  async (c, next) => {
    const isDev = c.env.ENVIRONMENT !== "production";
    const allowedOrigins = new Set(
      [c.env.ENVIRONMENT === "test" ? "*" : null].filter(Boolean) as string[]
    );

    const corsMiddleware = cors({
      origin: (requestOrigin) => {
        if (!requestOrigin) return "";
        // In unit tests, allow request origin
        if (c.env.ENVIRONMENT === "test") return requestOrigin;
        // In development, allow localhost origins
        if (isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)) {
          return requestOrigin;
        }
        // In production, match configured domains
        if (allowedOrigins.has(requestOrigin)) {
          return requestOrigin;
        }
        return "";
      },
      allowHeaders: ["Content-Type", "Authorization", "X-LicenKit-Signature", "Paddle-Signature", "Stripe-Signature", "X-Signature"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["Content-Length", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
      maxAge: 86400,
      credentials: true,
    });

    return corsMiddleware(c, next);
  }
);

// Mount API v1 Routes
const api = new Hono<AppContext>();

api.route("/system", systemRouter);
api.route("/auth", authRouter);
api.route("/client", clientRouter);

// Protected Admin Routes
const admin = new Hono<AppContext>();
admin.use("*", sessionAuth);
admin.route("/settings", adminSettingsRouter);
admin.route("/users", adminUsersRouter);
admin.route("/products", adminProductsRouter);
admin.route("/policies", adminPoliciesRouter);
admin.route("/licenses", adminLicensesRouter);
admin.route("/webhooks", adminWebhooksRouter);
admin.route("/stats", adminStatsRouter);
admin.route("/audit-logs", adminAuditRouter);

api.route("/admin", admin);
api.route("/webhooks", webhookRouter);

app.route("/api/v1", api);

// Static Assets Fallback (Single Domain Deployment)
app.all("*", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text("LicenKit Server is running. Static assets binding not configured.", 404);
});

import { cleanExpiredUnusedLicenses } from "./routes/admin/licenses.routes";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./infra/db/schema";

// Export Cloudflare Workers Handlers and App instance
export { app };
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
    await handleQueueBatch(batch, env);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = drizzle(env.DB, { schema });
    await cleanExpiredUnusedLicenses(db);
  },
};
