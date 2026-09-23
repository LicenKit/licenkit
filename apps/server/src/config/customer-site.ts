import { AppError } from "../middleware/error";
import { isSchemefulSameSite, isTrustedUrlProtocolAllowed } from "./trusted-url";

interface CustomerSiteRow {
  id: string;
  site_url: string;
  admin_api_url: string;
}

export interface CustomerSiteBoundary {
  instanceId: string;
  customerSiteUrl: string;
  customerSiteOrigin: string;
  adminApiUrl: string;
}

function invalidStoredUrl(
  code: string,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new AppError(code, message, 500, details, details);
}

function parseStoredCustomerSiteUrl(value: string, environment?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidStoredUrl(
      "CUSTOMER_SITE_URL_INVALID",
      "The Instance Customer Site URL is invalid",
      { violation: "invalid_url" },
    );
  }

  if (!isTrustedUrlProtocolAllowed(url, environment)) {
    invalidStoredUrl(
      "CUSTOMER_SITE_URL_INVALID",
      "The Instance Customer Site URL uses an unsupported protocol",
      { violation: "unsupported_protocol", protocol: url.protocol, hostname: url.hostname },
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    invalidStoredUrl(
      "CUSTOMER_SITE_URL_INVALID",
      "The Instance Customer Site URL contains unsupported components",
      {
        violation: "credentials_query_or_fragment",
        hasCredentials: Boolean(url.username || url.password),
        hasQuery: Boolean(url.search),
        hasFragment: Boolean(url.hash),
      },
    );
  }
  return url;
}

function parseStoredAdminApiUrl(value: string, environment?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidStoredUrl(
      "ADMIN_API_URL_INVALID",
      "The Instance Admin/API URL is invalid",
      { violation: "invalid_url" },
    );
  }

  if (!isTrustedUrlProtocolAllowed(url, environment)) {
    invalidStoredUrl(
      "ADMIN_API_URL_INVALID",
      "The Instance Admin/API URL uses an unsupported protocol",
      { violation: "unsupported_protocol", protocol: url.protocol, hostname: url.hostname },
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    invalidStoredUrl(
      "ADMIN_API_URL_INVALID",
      "The Instance Admin/API URL must be an exact Origin",
      { violation: "not_exact_origin", normalizedOrigin: url.origin },
    );
  }
  return url;
}

export async function resolveCustomerSiteBoundary(
  db: D1Database,
  requestUrl: string,
  environment?: string,
): Promise<CustomerSiteBoundary> {
  const requestOrigin = new URL(requestUrl).origin;
  const result = await db
    .prepare(
      `SELECT id, site_url, admin_api_url
       FROM instances
       WHERE status = 'active'
         AND admin_api_url = ?1
       LIMIT 1`,
    )
    .bind(requestOrigin)
    .all<CustomerSiteRow>();

  const row = result.results[0];
  if (!row) {
    throw new AppError(
      "CUSTOMER_API_ORIGIN_NOT_CONFIGURED",
      "No active Instance is configured for this Admin/API Origin",
      403,
      { requestOrigin },
    );
  }

  const adminApiUrl = parseStoredAdminApiUrl(row.admin_api_url, environment);
  const customerSiteUrl = parseStoredCustomerSiteUrl(row.site_url, environment);
  if (!isSchemefulSameSite(customerSiteUrl, adminApiUrl)) {
    invalidStoredUrl(
      "CUSTOMER_SITE_CROSS_SITE_UNSUPPORTED",
      "The Instance Customer Site and Admin/API URL must use the same schemeful site",
      {
        instanceId: row.id,
        customerSiteOrigin: customerSiteUrl.origin,
        adminApiOrigin: adminApiUrl.origin,
      },
    );
  }

  return {
    instanceId: row.id,
    customerSiteUrl: row.site_url,
    customerSiteOrigin: customerSiteUrl.origin,
    adminApiUrl: adminApiUrl.origin,
  };
}
