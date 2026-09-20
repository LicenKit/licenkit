import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

test("site build keeps checkout, customer portal, and magic-link policies separate", () => {
  const index = readFileSync(join(dist, "index.html"), "utf8");
  const magicLink = readFileSync(join(dist, "customer-magic-link.html"), "utf8");
  const headers = readFileSync(join(dist, "_headers"), "utf8");

  assert.match(index, /cdn\.paddle\.com/);
  assert.match(index, /\/assets\//);
  assert.match(magicLink, /challenges\.cloudflare\.com/);
  assert.doesNotMatch(magicLink, /cdn\.paddle\.com/);
  assert.match(headers, /\/customer\/\*/);
  assert.match(headers, /\/customer-magic-link\.html/);
  assert.match(headers, /Cache-Control: no-store/);
  assert.match(headers, /frame-ancestors 'none'/);
});
