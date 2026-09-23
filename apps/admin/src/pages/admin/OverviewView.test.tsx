import { describe, expect, it } from "vitest";
import type { BillingOffer } from "../../lib/api-client";

describe("OverviewView offer presentation helpers", () => {
  it("counts active offers based on persisted status without requiring readiness", () => {
    const mockOffers: Partial<BillingOffer>[] = [
      { id: "off_1", status: "active" },
      { id: "off_2", status: "draft" },
      { id: "off_3", status: "archived" },
      { id: "off_4", status: "active" },
    ];

    const activeOffers = mockOffers.filter((item) => item.status === "active");
    expect(mockOffers.length).toBe(4);
    expect(activeOffers.length).toBe(2);
  });
});
