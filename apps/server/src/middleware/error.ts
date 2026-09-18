import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

export class AppError extends Error {
  code: string;
  status: ContentfulStatusCode;

  constructor(
    code: string,
    message: string,
    status: ContentfulStatusCode = 400
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
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

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError || err instanceof ConfigurationError || (err && (err as any).code === "CONFIGURATION_ERROR")) {
    return c.json(
      {
        success: false,
        error: {
          code: (err as any).code || "APP_ERROR",
          message: err.message,
        },
      },
      (err as any).status || 500
    );
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
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
      },
    },
    500
  );
};
