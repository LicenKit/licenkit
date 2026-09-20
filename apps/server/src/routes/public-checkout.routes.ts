import { Hono } from "hono";
import type { AppContext } from "../types";
import { loadPublicCheckoutConfiguration } from "../services/billing/public-checkout";

export const publicCheckoutRouter = new Hono<AppContext>();

publicCheckoutRouter.get("/accounts/:accountSlug/products/:productSlug/checkout", async (c) => {
  const config = await loadPublicCheckoutConfiguration(
    c.env.DB,
    c.req.param("accountSlug"),
    c.req.param("productSlug"),
  );
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "no-store");
  c.header("Vary", "Origin");
  if (!config.found) {
    return c.json({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Public checkout product was not found.",
        request_id: c.get("requestId") ?? "unknown",
      },
    }, 404);
  }
  const { found: _found, ...data } = config;
  return c.json({ success: true, data });
});
