import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../types";
import { AppError } from "./error";

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

// In-memory sliding window cache for Worker isolate
const memoryStore = new Map<string, RateLimitRecord>();

function cleanupMemoryStore(now: number) {
  if (memoryStore.size > 5_000) {
    for (const [key, record] of memoryStore.entries()) {
      if (record.resetAt <= now) {
        memoryStore.delete(key);
      }
    }
  }
}

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  keyPrefix: string;
}

/**
 * Rate Limiting Middleware
 * Uses Cloudflare KV if available, or in-memory sliding window cache.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppContext> {
  const { limit, windowSeconds, keyPrefix } = options;

  return async (c, next) => {
    // Skip rate limiting in unit test runner
    if (c.env.ENVIRONMENT === "test") {
      await next();
      return;
    }

    const clientIp =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";

    const key = `rl:${keyPrefix}:${clientIp}`;
    const now = Math.floor(Date.now() / 1000);

    let currentCount = 0;
    let resetAt = now + windowSeconds;

    if (c.env.KEYS_KV) {
      try {
        const stored = await c.env.KEYS_KV.get(key);
        if (stored) {
          const parsed = JSON.parse(stored) as RateLimitRecord;
          if (parsed.resetAt > now) {
            currentCount = parsed.count;
            resetAt = parsed.resetAt;
          }
        }
        currentCount += 1;
        await c.env.KEYS_KV.put(
          key,
          JSON.stringify({ count: currentCount, resetAt }),
          { expirationTtl: Math.max(60, windowSeconds) }
        );
      } catch {
        currentCount = 0;
      }
    }

    if (!c.env.KEYS_KV || currentCount === 0) {
      cleanupMemoryStore(now);
      const record = memoryStore.get(key);
      if (record && record.resetAt > now) {
        record.count += 1;
        currentCount = record.count;
        resetAt = record.resetAt;
      } else {
        currentCount = 1;
        resetAt = now + windowSeconds;
        memoryStore.set(key, { count: currentCount, resetAt });
      }
    }

    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(Math.max(0, limit - currentCount)));
    c.header("X-RateLimit-Reset", String(resetAt));

    if (currentCount > limit) {
      c.header("Retry-After", String(Math.max(1, resetAt - now)));
      throw new AppError(
        "TOO_MANY_REQUESTS",
        `Too many requests. Please try again in ${Math.max(1, resetAt - now)} seconds.`,
        429
      );
    }

    await next();
  };
}
