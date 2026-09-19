import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/types";
import { consumeRateLimit, rateLimit } from "../src/middleware/rate-limit";
import { AppError, errorHandler } from "../src/middleware/error";
import { createTestEnv } from "./helpers/mock-d1";

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
  } as unknown as KVNamespace;
}

describe("V1 durable rate limiting", () => {
  it("shares the counter through KV and returns the exact retry window", async () => {
    const store = memoryKv();
    await expect(consumeRateLimit(store, "rl:test", {
      limit: 1,
      windowSeconds: 60,
      nowSeconds: 100,
    })).resolves.toEqual({ count: 1, resetAt: 160 });
    await expect(consumeRateLimit(store, "rl:test", {
      limit: 1,
      windowSeconds: 60,
      nowSeconds: 101,
    })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      status: 429,
      details: { retry_after_seconds: 59 },
    });
  });

  it("fails closed and preserves the underlying store error", async () => {
    const store = {
      get: async () => { throw new Error("kv unavailable"); },
    } as unknown as KVNamespace;
    try {
      await consumeRateLimit(store, "rl:test", { limit: 1, windowSeconds: 60 });
      throw new Error("expected consumeRateLimit to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "RATE_LIMIT_STORE_UNAVAILABLE",
        status: 503,
        source: { cause: "kv unavailable" },
      });
    }
  });

  it("executes the same rate-limit middleware in the test environment", async () => {
    const app = new Hono<AppContext>();
    app.onError(errorHandler);
    app.use("*", async (c, next) => {
      c.set("requestId", "req_rate_limit_test");
      await next();
    });
    app.use("*", rateLimit({ limit: 1, windowSeconds: 60, keyPrefix: "route_test" }));
    app.get("/", (c) => c.json({ success: true }));
    const { env } = createTestEnv({ ENVIRONMENT: "test" });
    const request = () => app.request("http://test/", {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    }, env);

    await expect(request()).resolves.toMatchObject({ status: 200 });
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });
});
