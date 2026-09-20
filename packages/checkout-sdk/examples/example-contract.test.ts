import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  "utf8",
);

describe("reference product pages", () => {
  it("uses the same headless SDK contract in React and framework-free examples", () => {
    const react = read("./react-vite/src/App.tsx");
    const vanilla = read("./vanilla/main.js");
    for (const source of [react, vanilla]) {
      expect(source).toContain("createLicenKitCheckout");
      expect(source).toContain(".load(");
      expect(source).toContain(".previewPrices(");
      expect(source).toContain(".open(");
      expect(source).not.toMatch(/\bpri_[a-zA-Z0-9]/);
      expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|dangerouslySetInnerHTML|innerHTML/);
    }
  });

  it("ships explicit security headers without broad script or frame wildcards", () => {
    for (const relativePath of ["./react-vite/_headers", "./vanilla/_headers"]) {
      const headers = read(relativePath);
      expect(headers).toContain("Content-Security-Policy:");
      expect(headers).toContain("script-src 'self' https://cdn.paddle.com");
      expect(headers).toContain("frame-src https://buy.paddle.com https://sandbox-buy.paddle.com");
      expect(headers).toContain("frame-ancestors 'none'");
      expect(headers).toContain("X-Content-Type-Options: nosniff");
      expect(headers).toContain("Referrer-Policy:");
      expect(headers).toContain("Permissions-Policy:");
      expect(headers).not.toContain("unsafe-eval");
      expect(headers).not.toMatch(/script-src[^\n;]*\*/);
      expect(headers).not.toMatch(/frame-src[^\n;]*\*/);
    }
  });
});
