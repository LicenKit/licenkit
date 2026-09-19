export class OutboundUrlPolicyError extends Error {
  readonly code = "OUTBOUND_ENDPOINT_NOT_PUBLIC";
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlPolicyError";
  }
}

export function requirePublicHttpsUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new OutboundUrlPolicyError("Outbound endpoint URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new OutboundUrlPolicyError("Outbound endpoints must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new OutboundUrlPolicyError("URL credentials are not allowed");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new OutboundUrlPolicyError("Non-standard HTTPS ports are not allowed");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new OutboundUrlPolicyError("Localhost targets are not allowed");
  }
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new OutboundUrlPolicyError("Private DNS suffixes are not allowed");
  }
  if (hostname === "metadata.google.internal" || hostname === "metadata.aws.internal") {
    throw new OutboundUrlPolicyError("Cloud metadata targets are not allowed");
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    throw new OutboundUrlPolicyError("IP literal targets are not allowed");
  }
  return parsed;
}

