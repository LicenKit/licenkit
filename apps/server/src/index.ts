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
import { webhookRouter } from "./routes/webhook.routes";
import { handleQueueBatch, type WebhookMessage } from "./queue/consumer";

const app = new Hono<AppContext>();

// Global Error Handler
app.onError(errorHandler);

// Global CORS Configuration
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowHeaders: ["Content-Type", "Authorization", "X-LicenKit-Signature"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
    credentials: true,
  })
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

// Export Cloudflare Workers Handlers and App instance
export { app };
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
    await handleQueueBatch(batch, env);
  },
};
