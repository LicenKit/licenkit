import type { MiddlewareHandler } from "hono";
import { resolveCustomerSiteBoundary } from "../config/customer-site";
import type { AppContext } from "../types";
import { AppError } from "./error";
import { validateCustomerSiteOrigin } from "./auth";

const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"] as const;
const ALLOWED_ACTUAL_METHODS = ["GET", "POST"] as const;
const ALLOWED_HEADERS = ["Content-Type", "X-CSRF-Token", "X-Request-Id"] as const;
const ALLOWED_HEADER_NAMES = new Set(ALLOWED_HEADERS.map((header) => header.toLowerCase()));

function appendVary(c: Parameters<MiddlewareHandler<AppContext>>[0], value: string): void {
  const current = c.res.headers.get("Vary");
  const values = new Set(
    current?.split(",").map((item) => item.trim()).filter(Boolean) ?? [],
  );
  values.add(value);
  c.header("Vary", [...values].join(", "));
}

function applyCustomerCorsResponseHeaders(
  c: Parameters<MiddlewareHandler<AppContext>>[0],
  allowedOrigin: string,
): void {
  c.header("Access-Control-Allow-Origin", allowedOrigin);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Expose-Headers", "X-Request-Id");
  appendVary(c, "Origin");
}

export const customerCors: MiddlewareHandler<AppContext> = async (c, next) => {
  const boundary = await resolveCustomerSiteBoundary(c.env.DB, c.req.url, c.env.ENVIRONMENT);
  const allowedOrigin = boundary.customerSiteOrigin;
  c.set("customerRequestInstanceId", boundary.instanceId);
  c.set("customerSiteOrigin", boundary.customerSiteOrigin);
  const requestOrigin = c.req.header("origin");

  if (c.req.method === "OPTIONS") {
    validateCustomerSiteOrigin(requestOrigin, allowedOrigin);

    const requestedMethod = c.req.header("access-control-request-method")?.toUpperCase();
    if (!requestedMethod || !ALLOWED_METHODS.includes(requestedMethod as typeof ALLOWED_METHODS[number])) {
      throw new AppError(
        "CUSTOMER_CORS_METHOD_NOT_ALLOWED",
        "The requested Customer API CORS method is not allowed",
        403,
        {
          requestedMethod: requestedMethod ?? null,
          allowedMethods: ALLOWED_METHODS,
        },
      );
    }

    const requestedHeaders = (c.req.header("access-control-request-headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    const rejectedHeaders = requestedHeaders.filter((header) => !ALLOWED_HEADER_NAMES.has(header));
    if (rejectedHeaders.length > 0) {
      throw new AppError(
        "CUSTOMER_CORS_HEADERS_NOT_ALLOWED",
        "The requested Customer API CORS headers are not allowed",
        403,
        { requestedHeaders, rejectedHeaders, allowedHeaders: ALLOWED_HEADERS },
      );
    }

    applyCustomerCorsResponseHeaders(c, allowedOrigin);
    c.header("Access-Control-Allow-Methods", ALLOWED_METHODS.join(","));
    c.header("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(","));
    c.header("Access-Control-Max-Age", "600");
    appendVary(c, "Access-Control-Request-Method");
    appendVary(c, "Access-Control-Request-Headers");
    return c.body(null, 204);
  }

  if (requestOrigin === allowedOrigin) {
    applyCustomerCorsResponseHeaders(c, allowedOrigin);
  } else {
    appendVary(c, "Origin");
  }
  if (!ALLOWED_ACTUAL_METHODS.includes(c.req.method as typeof ALLOWED_ACTUAL_METHODS[number])) {
    validateCustomerSiteOrigin(requestOrigin, allowedOrigin);
    throw new AppError(
      "CUSTOMER_CORS_METHOD_NOT_ALLOWED",
      "The Customer API request method is not allowed",
      403,
      { requestedMethod: c.req.method, allowedMethods: ALLOWED_ACTUAL_METHODS },
    );
  }
  await next();
};
