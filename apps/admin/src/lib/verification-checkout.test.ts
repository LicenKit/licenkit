import { describe, expect, it, vi } from "vitest";
import type { LicenKitCheckout } from "@licenkit/checkout";
import { openVerificationCheckout } from "./verification-checkout";

describe("openVerificationCheckout", () => {
  it("loads through the authenticated callback, opens the selected Offer, and always destroys the in-memory instance", async () => {
    const calls: string[] = [];
    const loadVerificationConfig = vi.fn(async () => ({ success: true, data: {} }));
    const checkout: LicenKitCheckout = {
      load: vi.fn(async () => {
        calls.push("load");
        await loadVerificationConfig();
        return { product: { slug: "example", name: "Example" }, available: true, reasonCodes: [], offers: [{ id: "offer_1", name: "Pro", purchaseType: "one_time" as const }] };
      }),
      previewPrices: vi.fn(),
      open: vi.fn(async ({ offerId }) => { calls.push(`open:${offerId}`); }),
      destroy: vi.fn(() => { calls.push("destroy"); }),
    };

    await openVerificationCheckout("offer_1", loadVerificationConfig, () => checkout);

    expect(loadVerificationConfig).toHaveBeenCalledOnce();
    expect(calls).toEqual(["load", "open:offer_1", "destroy"]);
  });

  it("destroys the instance when loading or opening fails", async () => {
    const destroy = vi.fn();
    const checkout: LicenKitCheckout = {
      load: vi.fn(async () => { throw new Error("invalid verification response"); }),
      previewPrices: vi.fn(),
      open: vi.fn(),
      destroy,
    };

    await expect(openVerificationCheckout("offer_1", vi.fn(), () => checkout)).rejects.toThrow("invalid verification response");
    expect(destroy).toHaveBeenCalledOnce();
  });
});
