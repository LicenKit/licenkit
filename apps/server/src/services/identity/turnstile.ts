import { AppError } from "../../middleware/error";

export const CUSTOMER_MAGIC_LINK_TURNSTILE_ACTION = "customer_magic_link";
export const PASSWORD_RESET_TURNSTILE_ACTION = "admin_password_reset";

interface TurnstileRuntimeEnv {
  TURNSTILE_SECRET_KEY?: string;
}

interface TurnstileSiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: unknown;
}

export interface VerifyCustomerMagicLinkTurnstileInput {
  env: TurnstileRuntimeEnv;
  token: string;
  expectedHostname: string;
  remoteIp?: string | null;
  fetchImpl?: typeof fetch;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function configurationError(): AppError {
  return new AppError(
    "TURNSTILE_CONFIGURATION_ERROR",
    "Turnstile is not configured for this authentication request",
    503,
  );
}

function unavailableError(
  details: Record<string, unknown> = {},
  source?: Record<string, unknown>,
): AppError {
  return new AppError(
    "TURNSTILE_VERIFICATION_UNAVAILABLE",
    "Turnstile verification could not be confirmed",
    503,
    { provider: "cloudflare_turnstile", ...details },
    source,
  );
}

function errorCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.slice(0, 128))
    .slice(0, 20);
}

/**
 * Verifies a single-use Turnstile token without persisting or logging either
 * the token or the complete Siteverify response. One transient retry reuses
 * the same Cloudflare idempotency key.
 */
export async function verifyCustomerMagicLinkTurnstile(
  input: VerifyCustomerMagicLinkTurnstileInput,
): Promise<void> {
  return verifyTurnstile({ ...input, action: CUSTOMER_MAGIC_LINK_TURNSTILE_ACTION });
}

export async function verifyTurnstile(
  input: VerifyCustomerMagicLinkTurnstileInput & { action: string },
): Promise<void> {
  const secret = input.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret || secret.startsWith("replace-with-")) throw configurationError();

  const expectedHostname = input.expectedHostname.trim().toLowerCase();
  if (!expectedHostname) throw configurationError();

  const idempotencyKey = crypto.randomUUID();
  const body = new URLSearchParams({
    secret,
    response: input.token,
    idempotency_key: idempotencyKey,
  });
  if (input.remoteIp) body.set("remoteip", input.remoteIp);

  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchImpl(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      if (attempt === 0) continue;
      throw unavailableError(
        { failure: "transport" },
        { providerError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) },
      );
    }
    if (response.status >= 500 && attempt === 0) continue;
    break;
  }

  if (!response?.ok) {
    throw unavailableError({ failure: "http", httpStatus: response?.status ?? null });
  }

  let result: TurnstileSiteverifyResponse;
  try {
    result = await response.json<TurnstileSiteverifyResponse>();
  } catch {
    throw unavailableError({ failure: "invalid_json", httpStatus: response.status });
  }

  if (
    result.success !== true
    || result.action !== input.action
    || result.hostname?.trim().toLowerCase() !== expectedHostname
  ) {
    throw new AppError(
      "TURNSTILE_VERIFICATION_FAILED",
      "Turnstile verification failed",
      400,
      {
        provider: "cloudflare_turnstile",
        errorCodes: errorCodes(result["error-codes"]),
        action: result.action ?? null,
        actionMatched: result.action === input.action,
        hostnameMatched: result.hostname?.trim().toLowerCase() === expectedHostname,
      },
    );
  }
}
