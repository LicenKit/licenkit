import { describe, expect, it } from "vitest";
import { isSchemefulSameSite, schemefulSite } from "../src/config/trusted-url";

describe("trusted URL schemeful-site boundary", () => {
  it.each([
    ["https://www.example.co.uk", "https://api.example.co.uk"],
    ["https://tidest.app", "https://license.tidest.app"],
    ["http://localhost:4321", "http://localhost:8787"],
    ["https://tenant.github.io", "https://api.tenant.github.io"],
  ])("treats %s and %s as the same schemeful site", (left, right) => {
    expect(isSchemefulSameSite(new URL(left), new URL(right))).toBe(true);
  });

  it.each([
    ["https://site.example.com", "https://api.other.example"],
    ["https://foo.github.io", "https://bar.github.io"],
    ["http://example.com", "https://example.com"],
    ["http://localhost:4321", "http://127.0.0.1:8787"],
  ])("keeps %s and %s in different schemeful sites", (left, right) => {
    expect(isSchemefulSameSite(new URL(left), new URL(right))).toBe(false);
  });

  it("reports the scheme and registrable domain without a port", () => {
    expect(schemefulSite(new URL("https://www.example.co.uk:8443"))).toBe(
      "https://example.co.uk",
    );
    expect(schemefulSite(new URL("http://localhost:4321"))).toBe("http://localhost");
  });
});
