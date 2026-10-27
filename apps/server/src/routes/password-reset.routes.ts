import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../types";
import { requireAdminAppOrigin } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { clearAdminCookies, requestIp } from "../services/identity/session";
import { PASSWORD_RESET_TURNSTILE_ACTION, verifyTurnstile } from "../services/identity/turnstile";
import {
  consumePasswordReset, dispatchPasswordReset, passwordResetEmailConfiguration,
  requestPasswordReset, trustedPasswordResetOrigin,
} from "../services/identity/password-reset";

export const passwordResetRouter = new Hono<AppContext>();
passwordResetRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

const RequestSchema = z.object({
  email: z.string().trim().email().max(320),
  turnstile_token: z.string().trim().min(1).max(2048),
}).strict();
const ConsumeSchema = z.object({
  token: z.string().regex(/^prk_[0-9a-f]{64}$/),
  new_password: z.string().min(12).max(256),
}).strict();

passwordResetRouter.get("/config", async (c) => {
  passwordResetEmailConfiguration(c.env);
  await trustedPasswordResetOrigin(c.env, new URL(c.req.url).origin);
  const siteKey = c.env.TURNSTILE_SITE_KEY?.trim();
  if (!siteKey || siteKey.startsWith("replace-with-") || !c.env.TURNSTILE_SECRET_KEY?.trim()) {
    throw new AppError("PASSWORD_RESET_UNAVAILABLE", "Password recovery by email is temporarily unavailable. Contact the deployment administrator.", 503);
  }
  return c.json({ success: true, data: { turnstile_site_key: siteKey, turnstile_action: PASSWORD_RESET_TURNSTILE_ACTION } });
});

passwordResetRouter.post("/request", requireAdminAppOrigin, async (c) => {
  const startedAt = Date.now();
  const input = RequestSchema.parse(await c.req.json());
  // Shared configuration and bot verification precede every account lookup.
  passwordResetEmailConfiguration(c.env);
  const adminOrigin = await trustedPasswordResetOrigin(c.env, new URL(c.req.url).origin);
  await verifyTurnstile({ env: c.env, token: input.turnstile_token,
    action: PASSWORD_RESET_TURNSTILE_ACTION, expectedHostname: new URL(adminOrigin).hostname, remoteIp: requestIp(c) });
  const id = await requestPasswordReset({ env: c.env, email: input.email, adminOrigin,
    request: { requestId: c.get("requestId"), ip: requestIp(c), userAgent: c.req.header("user-agent") } });
  if (id) {
    let context: { waitUntil(promise: Promise<unknown>): void } | undefined;
    try { context = c.executionCtx } catch { /* Cron processes the durable request outside the Worker runtime. */ }
    if (context) context.waitUntil(dispatchPasswordReset(c.env, id));
  }
  const remaining = 200 + crypto.getRandomValues(new Uint8Array(1))[0] % 26 - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return c.json({ success: true, data: { accepted: true } }, 202);
});

passwordResetRouter.post("/consume", requireAdminAppOrigin, async (c) => {
  const input = ConsumeSchema.parse(await c.req.json());
  const adminOrigin = await trustedPasswordResetOrigin(c.env, new URL(c.req.url).origin);
  await consumePasswordReset({ env: c.env, token: input.token, newPassword: input.new_password, adminOrigin,
    request: { requestId: c.get("requestId"), ip: requestIp(c), userAgent: c.req.header("user-agent") } });
  clearAdminCookies(c);
  return c.json({ success: true, data: { password_reset: true } });
});
