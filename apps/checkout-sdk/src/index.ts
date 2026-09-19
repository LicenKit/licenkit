import { createCheckoutCore } from "./core";
import type { LicenKitCheckout, LicenKitCheckoutOptions } from "./types";
import { LicenKitCheckoutError } from "./types";
import { parseCheckoutResponse, validateBaseUrl, validateSlug } from "./validation";

export * from "./types";

export function createLicenKitCheckout(options: LicenKitCheckoutOptions): LicenKitCheckout {
  const baseUrl = validateBaseUrl(options.licenkitBaseUrl);
  const accountSlug = validateSlug(options.accountSlug, "accountSlug");
  const productSlug = validateSlug(options.productSlug, "productSlug");
  const endpoint = new URL(
    `/api/v1/public/accounts/${encodeURIComponent(accountSlug)}/products/${encodeURIComponent(productSlug)}/checkout`,
    baseUrl,
  );
  return createCheckoutCore({
    onEvent: options.onEvent,
    async loadConfiguration() {
      let response: Response;
      try {
        response = await fetch(endpoint, { method: "GET", credentials: "omit", cache: "no-store", redirect: "manual" });
      } catch (error) {
        throw new LicenKitCheckoutError("CHECKOUT_CONFIG_UNAVAILABLE", "Public Checkout configuration request failed.", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      if (response.type === "opaqueredirect" || new URL(response.url || endpoint.href).origin !== baseUrl.origin) {
        throw new LicenKitCheckoutError("CHECKOUT_CONFIG_INVALID", "Public Checkout API redirected across origins.");
      }
      if (!response.ok) {
        throw new LicenKitCheckoutError("CHECKOUT_CONFIG_UNAVAILABLE", "Public Checkout API returned an error.", {
          httpStatus: response.status,
          requestId: response.headers.get("x-request-id"),
        });
      }
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new LicenKitCheckoutError("CHECKOUT_CONFIG_INVALID", "Public Checkout API returned malformed JSON."); }
      const configuration = parseCheckoutResponse(body);
      if (baseUrl.protocol === "http:" && configuration.available && configuration.environment !== "sandbox") {
        throw new LicenKitCheckoutError(
          "CHECKOUT_CONFIG_INVALID",
          "HTTP localhost is allowed only for Paddle Sandbox Checkout.",
        );
      }
      return configuration;
    },
  });
}
