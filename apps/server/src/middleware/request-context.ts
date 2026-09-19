import type { MiddlewareHandler } from "hono";
import { ulid } from "ulid";
import type { AppContext } from "../types";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const requestContext: MiddlewareHandler<AppContext> = async (c, next) => {
  const supplied = c.req.header("x-request-id")?.trim();
  const requestId = supplied && SAFE_REQUEST_ID.test(supplied)
    ? supplied
    : `req_${ulid().toLowerCase()}`;

  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  await next();
};
