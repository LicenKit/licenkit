import { bufferToHex, sha256Hex } from "../../infra/crypto";
import { AppError } from "../../middleware/error";

const TOKEN_PREFIX_PATTERN = /^[a-z][a-z0-9]{1,15}$/;

export interface OneTimeLinkSecret {
  token: string;
  tokenHash: string;
}

export interface PreparedOneTimeLink extends OneTimeLinkSecret {
  url: string;
}

/**
 * Generates a password-strength bearer token while keeping its durable form
 * separate. Callers persist only tokenHash; token may live only in the
 * encrypted Delivery payload and the browser page's memory.
 */
export async function createOneTimeLinkSecret(
  prefix: string,
): Promise<OneTimeLinkSecret> {
  if (!TOKEN_PREFIX_PATTERN.test(prefix)) {
    throw new AppError(
      "ONE_TIME_LINK_PREFIX_INVALID",
      "One-time link token prefix is invalid",
      500,
    );
  }
  const token = `${prefix}_${bufferToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { token, tokenHash: await sha256Hex(token) };
}

export async function hashOneTimeLinkToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/**
 * Builds an HTTPS URL from a trusted configured URL's Origin. The configured
 * path, query and fragment never influence the Admin landing path, and the
 * bearer token is placed only in the fragment so it is absent from HTTP and
 * Referer data.
 */
export function buildTrustedFragmentUrl(input: {
  trustedUrl: string;
  path: `/${string}`;
  token: string;
  pathBase?: "origin" | "trusted_path";
}): string {
  let trusted: URL;
  try {
    trusted = new URL(input.trustedUrl);
  } catch {
    throw new AppError(
      "ONE_TIME_LINK_TRUSTED_URL_INVALID",
      "The trusted one-time link URL is invalid",
      500,
    );
  }
  if (
    trusted.protocol !== "https:" ||
    trusted.username ||
    trusted.password ||
    trusted.search ||
    trusted.hash
  ) {
    throw new AppError(
      "ONE_TIME_LINK_TRUSTED_URL_INVALID",
      "The trusted one-time link URL must be HTTPS and cannot contain credentials, query, or fragment data",
      500,
    );
  }
  if (!input.path.startsWith("/") || input.path.includes("?") || input.path.includes("#")) {
    throw new AppError(
      "ONE_TIME_LINK_PATH_INVALID",
      "The one-time link path is invalid",
      500,
    );
  }
  const trustedPath = trusted.pathname.replace(/\/+$/, "");
  const url = new URL(trusted.origin);
  url.pathname = input.pathBase === "trusted_path"
    ? `${trustedPath}${input.path}`
    : input.path;
  url.hash = `token=${encodeURIComponent(input.token)}`;
  return url.toString();
}

export async function prepareOneTimeLink(input: {
  tokenPrefix: string;
  trustedUrl: string;
  path: `/${string}`;
  pathBase?: "origin" | "trusted_path";
}): Promise<PreparedOneTimeLink> {
  const secret = await createOneTimeLinkSecret(input.tokenPrefix);
  return {
    ...secret,
    url: buildTrustedFragmentUrl({
      trustedUrl: input.trustedUrl,
      path: input.path,
      token: secret.token,
      pathBase: input.pathBase,
    }),
  };
}
