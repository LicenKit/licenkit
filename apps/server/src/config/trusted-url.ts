import { getDomain } from "tldts";

const DOMAIN_OPTIONS = Object.freeze({ allowPrivateDomains: true });

/**
 * One-time links are HTTPS-only except for explicit local development/test
 * environments. The HTTP exception is deliberately limited to the two IPv4
 * loopback hostnames supported by the local tooling; IPv6 loopback is not
 * accepted by this contract.
 */
export function isTrustedUrlProtocolAllowed(
  url: URL,
  environment: string | undefined,
): boolean {
  if (url.protocol === "https:") return true;
  return Boolean(
    environment &&
    environment !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1"),
  );
}

/**
 * Returns the browser-style schemeful site used by SameSite cookies. Ports do
 * not participate in this boundary. Private suffixes such as github.io must be
 * included so two unrelated tenants are never treated as the same site.
 */
export function schemefulSite(url: URL): string {
  const registrableDomain = getDomain(url.hostname, DOMAIN_OPTIONS);
  return `${url.protocol}//${registrableDomain ?? url.hostname.toLowerCase()}`;
}

export function isSchemefulSameSite(left: URL, right: URL): boolean {
  if (left.protocol !== right.protocol) return false;
  if (left.hostname === right.hostname) return true;

  const leftDomain = getDomain(left.hostname, DOMAIN_OPTIONS);
  const rightDomain = getDomain(right.hostname, DOMAIN_OPTIONS);
  return Boolean(leftDomain && rightDomain && leftDomain === rightDomain);
}
