import { afterEach, describe, expect, it, vi } from "vitest";
import { openPaddleCheckout } from "./paddle-checkout";

describe("openPaddleCheckout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens the configured static Paddle Price with quantity one and no LicenKit request", async () => {
    const setup = vi.fn();
    const open = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("location", { href: "https://shop.example.test/", origin: "https://shop.example.test" });
    vi.stubGlobal("window", {
      Paddle: {
        Environment: { set: vi.fn() },
        Setup: setup,
        Checkout: { open },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await openPaddleCheckout({
      environment: "sandbox",
      clientSideToken: "test_client_token",
      priceId: "pri_static123",
      successUrl: "https://shop.example.test/purchase-success.html",
    });

    expect(setup).toHaveBeenCalledWith({ token: "test_client_token" });
    expect(open).toHaveBeenCalledWith({
      items: [{ priceId: "pri_static123", quantity: 1 }],
      settings: { successUrl: "https://shop.example.test/purchase-success.html" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
