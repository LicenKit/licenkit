import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bufferToHex, sha256Hex } from "../../infra/crypto";

export const ADMIN_SESSION_COOKIE = "__Host-licenkit-admin-session";
export const ADMIN_ACCOUNT_COOKIE = "__Host-licenkit-admin-account";
export const ADMIN_CSRF_COOKIE = "__Host-licenkit-admin-csrf";
export const CUSTOMER_SESSION_COOKIE = "__Host-licenkit-customer-session";
export const CUSTOMER_ACCOUNT_COOKIE = "__Host-licenkit-customer-account";
export const CUSTOMER_CSRF_COOKIE = "__Host-licenkit-customer-csrf";

function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${bufferToHex(bytes)}`;
}

export async function createSessionSecrets(prefix: "adm" | "cus"): Promise<{
  sessionToken: string;
  sessionTokenHash: string;
  csrfToken: string;
  csrfTokenHash: string;
}> {
  const sessionToken = randomToken(prefix === "adm" ? "ast" : "cst");
  const csrfToken = randomToken(prefix === "adm" ? "acf" : "ccf");
  return {
    sessionToken,
    sessionTokenHash: await sha256Hex(sessionToken),
    csrfToken,
    csrfTokenHash: await sha256Hex(csrfToken),
  };
}

function cookieOptions(maxAge: number, httpOnly: boolean) {
  return {
    path: "/",
    secure: true,
    httpOnly,
    sameSite: "Lax" as const,
    maxAge,
  };
}

export function setAdminCookies(
  c: Context,
  input: { accountId: string; sessionToken: string; csrfToken: string; maxAge: number }
): void {
  setCookie(c, ADMIN_SESSION_COOKIE, input.sessionToken, cookieOptions(input.maxAge, true));
  setCookie(c, ADMIN_ACCOUNT_COOKIE, input.accountId, cookieOptions(input.maxAge, true));
  setCookie(c, ADMIN_CSRF_COOKIE, input.csrfToken, cookieOptions(input.maxAge, false));
}

export function setCustomerCookies(
  c: Context,
  input: { accountId: string; sessionToken: string; csrfToken: string; maxAge: number }
): void {
  setCookie(c, CUSTOMER_SESSION_COOKIE, input.sessionToken, cookieOptions(input.maxAge, true));
  setCookie(c, CUSTOMER_ACCOUNT_COOKIE, input.accountId, cookieOptions(input.maxAge, true));
  setCookie(c, CUSTOMER_CSRF_COOKIE, input.csrfToken, cookieOptions(input.maxAge, false));
}

export function clearAdminCookies(c: Context): void {
  for (const name of [ADMIN_SESSION_COOKIE, ADMIN_ACCOUNT_COOKIE, ADMIN_CSRF_COOKIE]) {
    deleteCookie(c, name, { path: "/", secure: true });
  }
}

export function clearCustomerCookies(c: Context): void {
  for (const name of [CUSTOMER_SESSION_COOKIE, CUSTOMER_ACCOUNT_COOKIE, CUSTOMER_CSRF_COOKIE]) {
    deleteCookie(c, name, { path: "/", secure: true });
  }
}

export function readAdminCookies(c: Context): {
  accountId?: string;
  sessionToken?: string;
  csrfToken?: string;
} {
  return {
    accountId: getCookie(c, ADMIN_ACCOUNT_COOKIE),
    sessionToken: getCookie(c, ADMIN_SESSION_COOKIE),
    csrfToken: getCookie(c, ADMIN_CSRF_COOKIE),
  };
}

export function readCustomerCookies(c: Context): {
  accountId?: string;
  sessionToken?: string;
  csrfToken?: string;
} {
  return {
    accountId: getCookie(c, CUSTOMER_ACCOUNT_COOKIE),
    sessionToken: getCookie(c, CUSTOMER_SESSION_COOKIE),
    csrfToken: getCookie(c, CUSTOMER_CSRF_COOKIE),
  };
}

export function positiveIntegerSetting(
  value: string | number | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function requestIp(c: Context): string | null {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    null
  );
}

