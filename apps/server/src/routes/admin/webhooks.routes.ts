import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq, and, desc } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { webhookEndpoints, webhookEvents, products } from "../../infra/db/schema";
import { bufferToHex } from "../../infra/crypto";
import { requireRole } from "../../middleware/auth";
import { NotFoundError } from "../../middleware/error";

export const adminWebhooksRouter = new Hono<AppContext>();

// GET /api/v1/admin/webhooks
adminWebhooksRouter.get("/", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const list = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.accountId, accountId))
    .all();

  return c.json({
    success: true,
    data: {
      items: list.map((w) => ({
        ...w,
        events: JSON.parse(w.events),
        secretMasked: "••••••••" + w.secret.slice(-4),
      })),
    },
  });
});

const CreateEndpointSchema = z.object({
  productId: z.string(),
  url: z.string().url(),
  events: z.array(z.string()).default(["*"]),
});

// POST /api/v1/admin/webhooks
adminWebhooksRouter.post("/", requireRole(["owner", "admin"]), async (c) => {
  const body = await c.req.json();
  const input = CreateEndpointSchema.parse(body);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.accountId, accountId)))
    .get();

  if (!product) {
    throw new NotFoundError("Product not found");
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
        url: input.url,
        secret, // Show once on creation
        events: input.events,
      },
    },
    201
  );
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
