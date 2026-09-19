import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../types";
import { AppError } from "./error";

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  keyPrefix: string;
  key?: (c: Parameters<MiddlewareHandler<AppContext>>[0]) => string | Promise<string>;
}

export async function consumeRateLimit(
  store: KVNamespace,
  key: string,
  options: { limit: number; windowSeconds: number; nowSeconds?: number; errorCode?: string; message?: string },
): Promise<{ count: number; resetAt: number }> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  let currentCount = 0;
  let resetAt = now + options.windowSeconds;
  try {
    const stored = await store.get(key);
    if (stored) {
      const parsed = JSON.parse(stored) as RateLimitRecord;
      if (parsed.resetAt > now) {
        currentCount = parsed.count;
        resetAt = parsed.resetAt;
      }
    }
    currentCount += 1;
    await store.put(
      key,
      JSON.stringify({ count: currentCount, resetAt }),
      { expirationTtl: Math.max(60, options.windowSeconds) },
    );
  } catch (error) {
    throw new AppError(
      "RATE_LIMIT_STORE_UNAVAILABLE",
      "Rate-limit state could not be read or updated",
      503,
      undefined,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (currentCount > options.limit) {
    throw new AppError(
      options.errorCode ?? "TOO_MANY_REQUESTS",
      options.message ?? "Too many requests. Please try again later.",
      429,
      { retry_after_seconds: Math.max(1, resetAt - now) },
    );
  }
  return { count: currentCount, resetAt };
}

/**
 * Rate Limiting Middleware
 * Uses the shared Cloudflare KV binding. Store failure is fail-closed so a
 * transient infrastructure problem cannot silently disable protection on one
 * Worker isolate.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppContext> {
  const { limit, windowSeconds, keyPrefix } = options;

  return async (c, next) => {
    const clientIp =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";

    const scope = options.key ? await options.key(c) : clientIp;
    const key = `rl:${keyPrefix}:${scope}`;
    const now = Math.floor(Date.now() / 1000);

    let result: { count: number; resetAt: number };
    try {
      result = await consumeRateLimit(c.env.KEYS_KV, key, {
        limit,
        windowSeconds,
        nowSeconds: now,
        message: "Too many requests. Please try again later.",
      });
    } catch (error) {
      if (error instanceof AppError && error.status === 429) {
        c.header("Retry-After", String(error.details?.retry_after_seconds ?? 1));
      }
      throw error;
    }
    const { count: currentCount, resetAt } = result;

    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(Math.max(0, limit - currentCount)));
    c.header("X-RateLimit-Reset", String(resetAt));

    await next();
  };
}
