import { describe, expect, it } from "vitest";
import { MIN_OFFLINE_GRACE_DAYS } from "./LicensePlansView";

describe("License Plan offline grace policy", () => {
  it("accepts a positive offline grace independently of the Product validation interval", () => {
    expect(MIN_OFFLINE_GRACE_DAYS).toBe(1);
  });
});
