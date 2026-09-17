import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq, and, desc } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { webhookEndpoints, webhookEvents, products } from "../../infra/db/schema";
import { bufferToHex, computeHmacSha256, computeOutboundWebhookSignature } from "../../infra/crypto";
import { requireRole } from "../../middleware/auth";
import { NotFoundError, AppError } from "../../middleware/error";

export const adminWebhooksRouter = new Hono<AppContext>();

export function validateWebhookUrl(urlString: string, isProduction: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new AppError("INVALID_URL", "Invalid webhook endpoint URL", 400);
  }

  if (isProduction && parsed.protocol !== "https:") {
    throw new AppError("INSECURE_PROTOCOL", "In production, webhook URLs must use HTTPS", 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AppError("INVALID_PROTOCOL", "Webhook URL protocol must be HTTP or HTTPS", 400);
  }

  const hostname = parsed.hostname.toLowerCase();

  const isPrivateHost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    hostname === "169.254.169.254";

  if (isProduction && isPrivateHost) {
    throw new AppError("SSRF_FORBIDDEN", "Webhook delivery to private, local, or loopback networks is blocked in production", 400);
  }
}

// GET /api/v1/admin/webhooks
adminWebhooksRouter.get("/", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const list = await db
    .select({
      id: webhookEndpoints.id,
      accountId: webhookEndpoints.accountId,
      productId: webhookEndpoints.productId,
      productName: products.name,
      url: webhookEndpoints.url,
      secret: webhookEndpoints.secret,
      events: webhookEndpoints.events,
      isActive: webhookEndpoints.isActive,
      createdAt: webhookEndpoints.createdAt,
      updatedAt: webhookEndpoints.updatedAt,
    })
    .from(webhookEndpoints)
    .leftJoin(products, eq(webhookEndpoints.productId, products.id))
    .where(eq(webhookEndpoints.accountId, accountId))
    .all();

  return c.json({
    success: true,
    data: {
      items: list.map((w) => {
        let eventsList: string[] = ["*"];
        try {
          eventsList = JSON.parse(w.events);
        } catch {}

        return {
          ...w,
          productName: w.productId === "*" ? "All Products" : w.productName || "Unknown Product",
          events: eventsList,
          secretMasked: "••••••••" + w.secret.slice(-4),
        };
      }),
    },
  });
});

const CreateEndpointSchema = z.object({
  productId: z.string().default("*"),
  url: z.string().url(),
  events: z.array(z.string()).default(["*"]),
});

// POST /api/v1/admin/webhooks
adminWebhooksRouter.post("/", requireRole(["owner", "admin"]), async (c) => {
  const body = await c.req.json();
  const input = CreateEndpointSchema.parse(body);

  const isProduction = c.env.ENVIRONMENT === "production";
  validateWebhookUrl(input.url, isProduction);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  let productName = "All Products";

  if (input.productId !== "*") {
    const product = await db
      .select()
      .from(products)
      .where(and(eq(products.id, input.productId), eq(products.accountId, accountId)))
      .get();

    if (!product) {
      throw new NotFoundError("Product not found");
    }
    productName = product.name;
  }

  const endpointId = `whe_${ulid().toLowerCase()}`;
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = `whsec_${bufferToHex(randomBytes)}`;
  const now = new Date().toISOString();

  await db.insert(webhookEndpoints).values({
    id: endpointId,
    accountId,
    productId: input.productId,
    url: input.url,
    secret,
    events: JSON.stringify(input.events),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  return c.json(
    {
      success: true,
      data: {
        id: endpointId,
        productId: input.productId,
        productName,
        url: input.url,
        secret, // Show once on creation
        events: input.events,
      },
    },
    201
  );
});

// POST /api/v1/admin/webhooks/:id/test
adminWebhooksRouter.post("/:id/test", requireRole(["owner", "admin"]), async (c) => {
  const id = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const endpoint = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, accountId)))
    .get();

  if (!endpoint) {
    throw new NotFoundError("Webhook endpoint not found");
  }

  const isProduction = c.env.ENVIRONMENT === "production";
  validateWebhookUrl(endpoint.url, isProduction);

  const now = new Date().toISOString();
  const testPayload = JSON.stringify({
    id: `evt_test_${ulid().toLowerCase()}`,
    event: "test.ping",
    created_at: now,
    data: {
      message: "Test ping from LicenKit webhook dispatcher",
      endpoint_id: endpoint.id,
      timestamp: now,
    },
  });

  const { signatureHeader } = await computeOutboundWebhookSignature(testPayload, endpoint.secret);
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LicenKit-Signature": signatureHeader,
        "User-Agent": "LicenKit-Webhook-Dispatcher/1.0",
      },
      body: testPayload,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    return c.json({
      success: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        durationMs,
        delivered: response.ok,
      },
    });
  } catch (err: any) {
    return c.json(
      {
        success: false,
        error: {
          message: err.message || "Failed to reach endpoint",
          durationMs: Date.now() - startTime,
        },
      },
      400
    );
  }
});

// DELETE /api/v1/admin/webhooks/:id
adminWebhooksRouter.delete("/:id", requireRole(["owner", "admin"]), async (c) => {
  const id = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const existing = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, accountId)))
    .get();

  if (!existing) {
    throw new NotFoundError("Webhook endpoint not found");
  }

  await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));

  return c.json({
    success: true,
    data: { message: "Webhook endpoint deleted successfully" },
  });
});

// GET /api/v1/admin/webhooks/events
adminWebhooksRouter.get("/events", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));

  const events = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.accountId, accountId))
    .orderBy(desc(webhookEvents.createdAt))
    .limit(limit)
    .all();

  return c.json({
    success: true,
    data: {
      items: events.map((e) => ({
        ...e,
        payload: JSON.parse(e.payload),
      })),
    },
  });
});
