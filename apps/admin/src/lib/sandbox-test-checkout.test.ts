import { describe, expect, it, vi } from "vitest";
import type { BillingTestCheckoutConfig, SuccessEnvelope } from "./api-client";
import { openSandboxTestCheckout, type PaddleRuntime } from "./sandbox-test-checkout";

function response(): SuccessEnvelope<BillingTestCheckoutConfig> {
  return {
    success: true,
    data: {
      checkout: {
        provider: "paddle",
        environment: "sandbox",
        clientSideToken: "test_client_token",
        priceId: "pri_monthly123",
        quantity: 1,
      },
    },
  };
}

describe("openSandboxTestCheckout", () => {
  it("opens the ordinary Sandbox checkout without a verification token", async () => {
    const payload = response();
    const checkoutOpen = vi.fn();
    const environmentSet = vi.fn();
    const initialize = vi.fn();
    const paddle: PaddleRuntime = {
      Environment: { set: environmentSet },
      Initialize: initialize,
      Checkout: { open: checkoutOpen },
    };

    await openSandboxTestCheckout(vi.fn(async () => payload), async () => paddle);

    expect(environmentSet).toHaveBeenCalledWith("sandbox");
    expect(initialize).toHaveBeenCalledWith({ token: "test_client_token" });
    expect(checkoutOpen).toHaveBeenCalledWith({
      items: [{ priceId: "pri_monthly123", quantity: 1 }],
    });
  });

  it("fails before loading Paddle when the authenticated response is invalid", async () => {
    const loadPaddle = vi.fn();
    await expect(openSandboxTestCheckout(
      vi.fn(async () => ({ success: true, data: {} } as SuccessEnvelope<BillingTestCheckoutConfig>)),
      loadPaddle,
    )).rejects.toThrow("PADDLE_TEST_CHECKOUT_CONFIG_INVALID");
    expect(loadPaddle).not.toHaveBeenCalled();
  });

  it("does not open checkout if Paddle.js cannot select Sandbox", async () => {
    const checkoutOpen = vi.fn();
    await expect(openSandboxTestCheckout(
      vi.fn(async () => response()),
      async () => ({ Initialize: vi.fn(), Checkout: { open: checkoutOpen } }),
    )).rejects.toThrow("PADDLE_INITIALIZATION_FAILED");
    expect(checkoutOpen).not.toHaveBeenCalled();
  });
});
