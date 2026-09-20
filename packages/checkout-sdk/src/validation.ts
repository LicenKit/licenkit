import { LicenKitCheckoutError, type InternalCheckoutConfiguration, type InternalOffer } from "./types";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("Expected an object.");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid(`${name} is invalid.`);
  return value;
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new LicenKitCheckoutError("CHECKOUT_CONFIG_INVALID", message, details);
}

export function validateBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { invalid("licenkitBaseUrl must be an absolute HTTPS origin."); }
  const sandboxLocalhost = url.protocol === "http:" && (
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  );
  if ((url.protocol !== "https:" && !sandboxLocalhost) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    invalid("licenkitBaseUrl must be an absolute HTTPS origin, except for explicit localhost Sandbox development.");
  }
  return url;
}

export function validateSlug(value: string, name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 100) {
    invalid(`${name} must be a normalized URL-safe slug.`);
  }
  return value;
}

export function validateSuccessUrl(
  value: string | undefined,
  environment: "sandbox" | "live",
): string | undefined {
  if (!value) return undefined;
  if (typeof location === "undefined") invalid("successUrl requires a browser location.");
  let url: URL;
  try { url = new URL(value, location.href); } catch { invalid("successUrl is invalid."); }
  const sandboxLocalhost = environment === "sandbox" && url.protocol === "http:" && (
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  );
  if ((url.protocol !== "https:" && !sandboxLocalhost) ||
      url.origin !== location.origin || url.username || url.password) {
    invalid("successUrl must be a same-origin HTTPS URL, except for localhost Sandbox development.");
  }
  return url.href;
}

function parseOffer(value: unknown): InternalOffer {
  const row = object(value);
  const purchaseType = row.purchaseType;
  if (purchaseType !== "one_time" && purchaseType !== "subscription") invalid("Offer purchaseType is invalid.");
  if (row.quantity !== 1) invalid("Offer quantity must be exactly 1.");
  const priceId = text(row.priceId, "Offer priceId", 128);
  if (!/^pri_[A-Za-z0-9]+$/.test(priceId)) invalid("Offer priceId is invalid.");
  return {
    id: text(row.id, "Offer id", 128),
    name: text(row.name, "Offer name", 200),
    purchaseType,
    priceId,
    quantity: 1,
  };
}

export function parseCheckoutResponse(value: unknown): InternalCheckoutConfiguration {
  const root = object(value);
  if (root.success !== true) invalid("Public Checkout API did not return success.");
  const data = object(root.data);
  const productValue = object(data.product);
  const checkout = object(data.checkout);
  const available = checkout.available;
  if (typeof available !== "boolean") invalid("checkout.available is invalid.");
  const product = {
    slug: text(productValue.slug, "Product slug", 100),
    name: text(productValue.name, "Product name", 200),
    ...(productValue.description === undefined
      ? {}
      : { description: text(productValue.description, "Product description", 2000) }),
  };
  if (!available) {
    if (!Array.isArray(checkout.reasonCodes) || !checkout.reasonCodes.every((code) => typeof code === "string" && code.length <= 100)) {
      invalid("Checkout reasonCodes are invalid.");
    }
    if (!Array.isArray(data.offers) || data.offers.length !== 0) invalid("Unavailable Checkout cannot expose Offers.");
    if (checkout.clientSideToken !== undefined || checkout.environment !== undefined || checkout.provider !== undefined) {
      invalid("Unavailable Checkout cannot expose provider credentials.");
    }
    return { product, available: false, reasonCodes: [...checkout.reasonCodes], offers: [] };
  }
  if (checkout.provider !== "paddle") invalid("Only Paddle is supported by the V1 Checkout SDK.");
  if (checkout.environment !== "sandbox" && checkout.environment !== "live") invalid("Checkout environment is invalid.");
  const token = text(checkout.clientSideToken, "Paddle client-side token", 512);
  const expectedPrefix = checkout.environment === "sandbox" ? "test_" : "live_";
  if (!token.startsWith(expectedPrefix)) invalid("Paddle token does not match Checkout environment.");
  if (!Array.isArray(data.offers) || data.offers.length === 0 || data.offers.length > 100) invalid("Checkout Offers are invalid.");
  const offers = data.offers.map(parseOffer);
  if (new Set(offers.map((offer) => offer.id)).size !== offers.length) invalid("Checkout Offer IDs must be unique.");
  return {
    product,
    available: true,
    reasonCodes: [],
    provider: "paddle",
    environment: checkout.environment,
    clientSideToken: token,
    offers,
  };
}

export function parseVerificationResponse(value: unknown): InternalCheckoutConfiguration {
  const config = parseCheckoutResponse(value);
  const root = object(value);
  const data = object(root.data);
  if (data.verificationMode !== true || config.environment !== "sandbox" || config.offers.length !== 1) {
    invalid("Checkout verification requires one Paddle Sandbox Offer.");
  }
  const verificationToken = text(data.verificationToken, "Verification token", 256);
  if (!verificationToken.startsWith("vfy_")) invalid("Verification token is invalid.");
  return { ...config, verificationToken };
}
