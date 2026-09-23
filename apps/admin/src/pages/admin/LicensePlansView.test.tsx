import { describe, expect, it } from "vitest";
import { MIN_SIGNED_TOKEN_TTL_SECONDS } from "./LicensePlansView";

describe("License Plan signed token policy", () => {
  it("accepts any positive token lifetime independently of the validation interval", () => {
    expect(MIN_SIGNED_TOKEN_TTL_SECONDS).toBe(1);
  });
});
