import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLicenKitCheckout } from "./index";
import { createLicenKitVerificationCheckout } from "./admin";
import { paddleProviderErrorDetails } from "./paddle-runtime";
import { LicenKitCheckoutError } from "./types";
import { parseCheckoutResponse } from "./validation";

const publicConfig = {
  success: true,
  data: {
    product: { slug: "editor", name: "Editor" },
    checkout: {
      available: true,
      provider: "paddle",
      environment: "sandbox",
      clientSideToken: "test_client_token",
    },
    offers: [{
      id: "off_monthly",
      name: "Monthly",
      purchaseType: "subscription",
      priceId: "pri_monthly123",
      quantity: 1,
    }],
  },
};

function jsonResponse(body: unknown, url = "https://licenses.example.test/api/v1/public/config"): Response {
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("V1 headless Checkout SDK", () => {
  const checkoutOpen = vi.fn();
  const setup = vi.fn();

  beforeEach(() => {
    checkoutOpen.mockReset();
    setup.mockReset();
    vi.stubGlobal("location", { href: "https://shop.example.test/buy", origin: "https://shop.example.test" });
    vi.stubGlobal("document", {});
    vi.stubGlobal("window", {
      Paddle: {
        Environment: { set: vi.fn() },
        Setup: setup,
        PricePreview: vi.fn(async () => ({
          data: {
            currencyCode: "USD",
            details: {
              totals: { subtotal: "1000", tax: "0", total: "1000" },
              formattedTotals: { subtotal: "$10.00", tax: "$0.00", total: "$10.00" },
            },
          },
        })),
        Checkout: { open: checkoutOpen },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fails fast on unsafe base URLs and malformed response schemas", () => {
    expect(() => createLicenKitCheckout({
      licenkitBaseUrl: "http://licenses.example.test/",
      accountSlug: "acme",
      productSlug: "editor",
    })).toThrowError(LicenKitCheckoutError);
    expect(() => createLicenKitCheckout({
      licenkitBaseUrl: "http://example.test/",
      accountSlug: "acme",
      productSlug: "editor",
    })).toThrowError(LicenKitCheckoutError);
    expect(() => parseCheckoutResponse({
      ...publicConfig,
      data: { ...publicConfig.data, offers: [{ ...publicConfig.data.offers[0], quantity: 2 }] },
    })).toThrow(/quantity/);
    expect(() => parseCheckoutResponse({
      ...publicConfig,
      data: { ...publicConfig.data, checkout: { available: false, clientSideToken: "test_leak", reasonCodes: [] }, offers: [] },
    })).toThrow(/credentials/);
  });

  it("fetches with credentials omitted and rejects cross-origin redirects", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(publicConfig, "https://other.example.test/config"));
    vi.stubGlobal("fetch", fetchMock);
    const checkout = createLicenKitCheckout({
      licenkitBaseUrl: "https://licenses.example.test/",
      accountSlug: "acme",
      productSlug: "editor",
    });
    await expect(checkout.load()).rejects.toMatchObject({ code: "CHECKOUT_CONFIG_INVALID" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://licenses.example.test/api/v1/public/accounts/acme/products/editor/checkout"),
      { method: "GET", credentials: "omit", cache: "no-store", redirect: "manual" },
    );
  });

  it("allows HTTP localhost only when the resolved checkout is Sandbox", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
      publicConfig,
      "http://localhost:8787/api/v1/public/config",
    )));
    const sandbox = createLicenKitCheckout({
      licenkitBaseUrl: "http://localhost:8787/",
      accountSlug: "acme",
      productSlug: "editor",
    });
    await expect(sandbox.load()).resolves.toMatchObject({ available: true });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ...publicConfig,
      data: {
        ...publicConfig.data,
        checkout: {
          ...publicConfig.data.checkout,
          environment: "live",
          clientSideToken: "live_client_token",
        },
      },
    }, "http://localhost:8787/api/v1/public/config")));
    const live = createLicenKitCheckout({
      licenkitBaseUrl: "http://localhost:8787/",
      accountSlug: "acme",
      productSlug: "editor",
    });
    await expect(live.load()).rejects.toMatchObject({ code: "CHECKOUT_CONFIG_INVALID" });
  });

  it("maps an offerId to the configured single Paddle price with quantity one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(publicConfig)));
    const checkout = createLicenKitCheckout({
      licenkitBaseUrl: "https://licenses.example.test/",
      accountSlug: "acme",
      productSlug: "editor",
    });
    await checkout.load();
    await (checkout as any).open({
      offerId: "off_monthly",
      priceId: "pri_attacker",
      quantity: 99,
      customData: { fulfill_me: true },
      successUrl: "https://shop.example.test/thanks",
    });
    expect(checkoutOpen).toHaveBeenCalledWith({
      items: [{ priceId: "pri_monthly123", quantity: 1 }],
      settings: { successUrl: "https://shop.example.test/thanks" },
    });
  });

  it("keeps the admin verification token internal and consumes it after one open", async () => {
    const loadVerificationConfig = vi.fn(async () => ({
      ...publicConfig,
      data: {
        ...publicConfig.data,
        verificationMode: true,
        verificationToken: "vfy_one_time_secret",
      },
    }));
    const checkout = createLicenKitVerificationCheckout({ loadVerificationConfig });
    const visible = await checkout.load();
    expect(visible).not.toHaveProperty("verificationToken");
    await checkout.open({ offerId: "off_monthly" });
    await checkout.open({ offerId: "off_monthly" });
    expect(checkoutOpen.mock.calls[0][0]).toEqual({
      items: [{ priceId: "pri_monthly123", quantity: 1 }],
      customData: { licenkit_checkout_verification: "vfy_one_time_secret" },
    });
    expect(checkoutOpen.mock.calls[1][0]).toEqual({
      items: [{ priceId: "pri_monthly123", quantity: 1 }],
    });
    checkout.destroy();
  });

  it("preserves structured Paddle error identifiers without copying the raw payload", () => {
    const details = paddleProviderErrorDetails({
      error: {
        code: "checkout_origin_not_approved",
        message: "Website origin is not approved.",
      },
      data: {
        request_id: "req_01JTEST",
        client_side_token: "must_not_leak",
      },
    }, "live");

    expect(details).toEqual({
      environment: "live",
      providerCode: "checkout_origin_not_approved",
      providerRequestId: "req_01JTEST",
      providerMessage: "Website origin is not approved.",
    });
    expect(JSON.stringify(details)).not.toContain("must_not_leak");
  });
});
