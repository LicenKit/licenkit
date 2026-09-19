import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

export class AppError extends Error {
  code: string;
  status: ContentfulStatusCode;
  details?: Record<string, unknown>;
  source?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: ContentfulStatusCode = 400,
    details?: Record<string, unknown>,
    source?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.source = source;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized. Please login.") {
    super("UNAUTHORIZED", message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden. Access denied.") {
    super("FORBIDDEN", message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found.") {
    super("NOT_FOUND", message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(code = "CONFLICT", message = "Conflict detected.") {
    super(code, message, 409);
  }
}

import { ConfigurationError } from "../infra/crypto";
export { ConfigurationError };

function redactErrorSource(value: unknown, key = ""): unknown {
  const normalizedKey = key.toLowerCase();
  if (/password|secret|token|authorization|cookie|payload|private[_-]?key/.test(normalizedKey)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => redactErrorSource(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactErrorSource(childValue, childKey),
      ]),
    );
  }
  return value;
}

export const errorHandler: ErrorHandler = (err, c) => {
  const requestId = c.get("requestId") || c.req.header("x-request-id") || "unknown";

  if (err instanceof AppError || err instanceof ConfigurationError || (err && (err as any).code === "CONFIGURATION_ERROR")) {
    const appError = err as AppError;
    if (appError.source) {
      console.error("Application error source", {
        requestId,
        code: appError.code,
        status: appError.status,
        source: redactErrorSource(appError.source),
      });
    }
    return c.json(
      {
        success: false,
        error: {
          code: appError.code || "APP_ERROR",
          message: err.message,
          ...(appError.details ? { details: appError.details } : {}),
          request_id: requestId,
        },
      },
      appError.status || 500
    );
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
          details: {
            issues: err.errors.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
              message: issue.message,
            })),
          },
          request_id: requestId,
        },
      },
      400
    );
  }

  console.error("Unhandled Exception:", err);
  const isProduction = (c.env as any)?.ENVIRONMENT === "production";
  return c.json(
    {
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: isProduction ? "An internal error occurred" : (err.message || "An internal error occurred"),
        request_id: requestId,
      },
    },
    500
  );
};
