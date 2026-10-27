import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "..", "..", "dist", "admin");

test("admin build remains isolated under the reserved /admin path", () => {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const headers = readFileSync(join(dist, "_headers"), "utf8");

  assert.match(html, /\/admin\/assets\//);
  assert.match(html, /script-src 'self'/);
  assert.match(headers, /\/admin\/\*/);
  assert.match(headers, /Cache-Control: no-store/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /cdn\.paddle\.com/);
  assert.match(headers, /sandbox-buy\.paddle\.com/);
  assert.match(headers, /challenges\.cloudflare\.com/);
});
