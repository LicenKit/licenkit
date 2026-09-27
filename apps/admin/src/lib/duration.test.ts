import { describe, expect, it } from "vitest";
import { daysToSeconds, secondsToDays } from "./duration";

describe("admin duration conversion", () => {
  it("converts whole-day input to the server seconds contract", () => {
    expect(daysToSeconds("0")).toBe(0);
    expect(daysToSeconds("3")).toBe(259_200);
    expect(daysToSeconds("365")).toBe(31_536_000);
  });

  it("converts stored seconds back to day-based input", () => {
    expect(secondsToDays(2_592_000)).toBe("30");
    expect(() => secondsToDays(3_600)).toThrow("whole number of days");
  });

  it("rejects fractional or invalid day input", () => {
    expect(() => daysToSeconds("0.5")).toThrow("whole number of days");
    expect(() => daysToSeconds("not-a-number")).toThrow("whole number of days");
  });
});
