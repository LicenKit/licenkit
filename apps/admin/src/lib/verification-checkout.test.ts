import { describe, expect, it, vi } from "vitest";
import type { BillingVerificationConfig, SuccessEnvelope } from "./api-client";
import { openVerificationCheckout, type PaddleRuntime } from "./verification-checkout";

function response(): SuccessEnvelope<BillingVerificationConfig> {
  return {
    success: true,
    data: {
      verificationMode: true,
      verificationToken: "vfy_one_time_secret",
      expiresAt: "2026-09-20T08:00:00.000Z",
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

describe("openVerificationCheckout", () => {
  it("loads authenticated configuration, opens one Sandbox Price, and clears the token", async () => {
    const payload = response();
    const checkoutOpen = vi.fn();
    const environmentSet = vi.fn();
    const initialize = vi.fn();
    const paddle: PaddleRuntime = {
      Environment: { set: environmentSet },
      Initialize: initialize,
      Checkout: { open: checkoutOpen },
    };

    await openVerificationCheckout(vi.fn(async () => payload), async () => paddle);

    expect(environmentSet).toHaveBeenCalledWith("sandbox");
    expect(initialize).toHaveBeenCalledWith({ token: "test_client_token" });
    expect(checkoutOpen).toHaveBeenCalledWith({
      items: [{ priceId: "pri_monthly123", quantity: 1 }],
      customData: { licenkit_checkout_verification: "vfy_one_time_secret" },
    });
    expect(payload.data.verificationToken).toBe("");
  });

  it("fails before loading Paddle when the authenticated response is invalid", async () => {
    const loadPaddle = vi.fn();
    await expect(openVerificationCheckout(
      vi.fn(async () => ({ success: true, data: {} } as SuccessEnvelope<BillingVerificationConfig>)),
      loadPaddle,
    )).rejects.toThrow("PADDLE_VERIFICATION_CONFIG_INVALID");
    expect(loadPaddle).not.toHaveBeenCalled();
  });
});
