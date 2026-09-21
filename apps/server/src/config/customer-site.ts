import { AppError } from "../middleware/error";
import { isTrustedUrlProtocolAllowed } from "./trusted-url";

interface CustomerSiteOriginEnv {
  CUSTOMER_SITE_ORIGIN?: string;
  ENVIRONMENT?: string;
}

function invalidCustomerSiteOrigin(
  violation: string,
  parsed?: URL,
): never {
  const diagnostics = parsed
    ? {
        configuredOrigin: parsed.origin,
        configuredPath: parsed.pathname,
        hasCredentials: Boolean(parsed.username || parsed.password),
        hasQuery: Boolean(parsed.search),
        hasFragment: Boolean(parsed.hash),
      }
    : {};
  throw new AppError(
    "CUSTOMER_SITE_ORIGIN_INVALID",
    "CUSTOMER_SITE_ORIGIN must be an exact HTTPS Origin, except for non-production localhost or 127.0.0.1 HTTP, without credentials, path, query, or fragment",
    500,
    { violation, ...diagnostics },
    { violation, ...diagnostics },
  );
}

export function customerSiteOrigin(env: CustomerSiteOriginEnv): string {
  const configuredValue = env.CUSTOMER_SITE_ORIGIN?.trim();
  if (!configuredValue) {
    throw new AppError(
      "CUSTOMER_SITE_ORIGIN_MISSING",
      "CUSTOMER_SITE_ORIGIN is not configured",
      500,
    );
  }

  let url: URL;
  try {
    url = new URL(configuredValue);
  } catch {
    invalidCustomerSiteOrigin("invalid_url");
  }

  if (!isTrustedUrlProtocolAllowed(url, env.ENVIRONMENT)) {
    invalidCustomerSiteOrigin(
      url.protocol === "http:"
        ? "http_requires_nonproduction_loopback"
        : "unsupported_protocol",
      url,
    );
  }
  if (url.username || url.password) {
    invalidCustomerSiteOrigin("credentials_not_allowed", url);
  }
  if (url.pathname !== "/") {
    invalidCustomerSiteOrigin("path_not_allowed", url);
  }
  if (url.search) {
    invalidCustomerSiteOrigin("query_not_allowed", url);
  }
  if (url.hash) {
    invalidCustomerSiteOrigin("fragment_not_allowed", url);
  }
  if (url.origin !== configuredValue) {
    invalidCustomerSiteOrigin("non_canonical_origin", url);
  }
  return configuredValue;
}
