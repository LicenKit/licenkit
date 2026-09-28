import type { BillingEnvironment } from "./api-client";

export function buildPaddleWebhookUrl(
  adminApiUrl: string,
  instanceId: string,
  environment: BillingEnvironment,
): string {
  const url = new URL(adminApiUrl);
  url.pathname = `/api/v1/webhooks/payments/${encodeURIComponent(instanceId)}/paddle/${environment}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
