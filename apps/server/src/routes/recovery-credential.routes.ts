import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../types";
import { requireAdminAppOrigin } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { clearAdminCookies, requestIp } from "../services/identity/session";
import { takeIdentityRequestAllowance } from "../services/identity/password-reset";
import { recoverPasswordWithCredential } from "../services/identity/recovery-credential";

export const recoveryCredentialRouter = new Hono<AppContext>();
const RecoverSchema = z.object({
  email: z.string().trim().email().max(320),
  recovery_credential: z.string().regex(/^rcv_[0-9a-f]{64}$/),
  new_password: z.string().min(12).max(256),
}).strict();
recoveryCredentialRouter.post("/consume", requireAdminAppOrigin, async (c) => {
  c.header("Cache-Control", "no-store");
  const input = RecoverSchema.parse(await c.req.json());
  const now = new Date();
  if (!(await takeIdentityRequestAllowance(c.env, `recovery-credential:ip:${requestIp(c) ?? "unknown"}`, 10, 600_000, now))) {
    throw new AppError("RECOVERY_TOO_MANY_ATTEMPTS", "Too many recovery attempts. Please try again later.", 429);
  }
  const replacement = await recoverPasswordWithCredential({ db: c.env.DB, email: input.email,
    credential: input.recovery_credential, newPassword: input.new_password,
    request: { requestId: c.get("requestId"), ip: requestIp(c), userAgent: c.req.header("user-agent") } });
  clearAdminCookies(c);
  return c.json({ success: true, data: { password_reset: true, recovery_credential: replacement } });
});
