import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSite, watchSite } from "../build-site.mjs";
import { SiteConfigError, validateSiteConfig } from "../../apps/site/builtin/assets/config.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const defaults = JSON.parse(readFileSync(join(repositoryRoot, "apps/site/builtin/site.json"), "utf8"));

function fixture(t) {
  const cache = join(repositoryRoot, ".cache");
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, "site-build-test-"));
  const put = (path, contents) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    return target;
  };
  put("apps/site/builtin/site.json", JSON.stringify(defaults));
  put("apps/site/builtin/index.html", "builtin home");
  mkdirSync(join(root, "apps/site/custom"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, put, read: (path) => readFileSync(join(root, path), "utf8") };
}

function purchaseConfig() {
  return {
    ...structuredClone(defaults),
    paddle: { environment: "sandbox", clientSideToken: "test_public_token" },
    products: [{ id: "desktop-app", name: "Desktop App", description: "A product", plans: [{ name: "Annual", description: "One year", price: "$29 / year", priceId: "pri_example123" }] }],
  };
}

test("keeps both template trees separate, publishes empty custom files and preserves Admin/source files", (t) => {
  const f = fixture(t);
  f.put("apps/site/custom/index.html", "custom home");
  f.put("apps/site/custom/assets/theme.css", "");
  f.put("apps/site/custom/.gitkeep", "");
  f.put("apps/site/custom/.env", "SENDING_KEY=private");
  f.put("dist/admin/index.html", "existing Admin");
  const built = buildSite({ projectRoot: f.root });

  assert.equal(f.read("dist/__site/builtin/index.html"), "builtin home");
  assert.equal(f.read("dist/__site/custom/index.html"), "custom home");
  assert.equal(f.read("dist/__site/custom/assets/theme.css"), "");
  assert.equal(f.read("dist/admin/index.html"), "existing Admin");
  assert.equal(f.read("apps/site/custom/.env"), "SENDING_KEY=private");
  assert.equal(existsSync(join(f.root, "dist/__site/custom/.env")), false);
  assert.equal(existsSync(join(f.root, "dist/__site/custom/.gitkeep")), false);
  assert.equal(built.customCount, 2);
});

test("rebuild removes deleted published overrides without changing the builtin or user source", (t) => {
  const f = fixture(t);
  const custom = f.put("apps/site/custom/index.html", "custom home");
  buildSite({ projectRoot: f.root });
  rmSync(custom);
  buildSite({ projectRoot: f.root });
  assert.equal(existsSync(join(f.root, "dist/__site/custom/index.html")), false);
  assert.equal(f.read("dist/__site/builtin/index.html"), "builtin home");
  assert.equal(f.read("apps/site/builtin/index.html"), "builtin home");
});

test("validates the entire selected config and leaves previous output intact on an invalid override", (t) => {
  const f = fixture(t);
  buildSite({ projectRoot: f.root });
  f.put("apps/site/custom/site.json", JSON.stringify({ name: "Custom name" }));
  assert.throws(() => buildSite({ projectRoot: f.root }), /custom\/site\.json.*site\.description.*required/u);
  assert.equal(f.read("dist/__site/builtin/index.html"), "builtin home");
  assert.equal(existsSync(join(f.root, "dist/__site/custom/site.json")), false);
});

test("custom config wins as one file and malformed JSON does not leak contents or fall back", (t) => {
  const f = fixture(t);
  const custom = { ...structuredClone(defaults), name: "Custom name" };
  f.put("apps/site/custom/site.json", JSON.stringify(custom));
  assert.match(buildSite({ projectRoot: f.root }).configPath, /custom\/site\.json$/u);
  assert.deepEqual(JSON.parse(f.read("dist/__site/custom/site.json")), custom);
  f.put("apps/site/custom/site.json", '{"apiKey": "do-not-print-this-secret", ');
  assert.throws(() => buildSite({ projectRoot: f.root }), (error) => {
    assert.match(error.message, /custom\/site\.json: invalid JSON/u);
    assert.equal(error.message.includes("do-not-print-this-secret"), false);
    return true;
  });
  assert.deepEqual(JSON.parse(f.read("dist/__site/custom/site.json")), custom);
});

test("rejects reserved route and deployment control files before publishing", (t) => {
  for (const path of ["api/index.html", "admin.html", "__site/secret.txt", "_headers", "assets/_redirects", ".assetsignore", "server.key"]) {
    const f = fixture(t);
    f.put(`apps/site/custom/${path}`, "not public");
    assert.throws(() => buildSite({ projectRoot: f.root }), /reserved|control files|not a public Site resource/u);
    assert.equal(existsSync(join(f.root, "dist/__site")), false);
  }
});

test("rejects symbolic links instead of reading or copying an outside file", (t) => {
  const f = fixture(t);
  const privateFile = f.put("private.json", '{"secret":"private"}');
  symlinkSync(privateFile, join(f.root, "apps/site/custom/published.json"));
  assert.throws(() => buildSite({ projectRoot: f.root }), /symbolic links are not allowed/u);
  assert.equal(existsSync(join(f.root, "dist/__site")), false);
});

test("rejects a linked output parent without modifying its destination", (t) => {
  const f = fixture(t);
  f.put("outside/site-marker.txt", "leave intact");
  symlinkSync(join(f.root, "outside"), join(f.root, "dist"));
  assert.throws(() => buildSite({ projectRoot: f.root }), /dist.*must not be symbolic links/u);
  assert.equal(f.read("outside/site-marker.txt"), "leave intact");
  assert.equal(existsSync(join(f.root, "outside/__site")), false);
});

test("syntax-checks custom JavaScript modules before publishing without executing them", (t) => {
  const f = fixture(t);
  const marker = join(f.root, "must-not-execute.txt");
  f.put("apps/site/custom/assets/custom.js", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`);
  buildSite({ projectRoot: f.root });
  assert.equal(existsSync(marker), false);
  f.put("apps/site/custom/assets/custom.js", "export const = broken syntax;");
  assert.throws(() => buildSite({ projectRoot: f.root }), /custom\/assets\/custom\.js:1: invalid JavaScript module syntax/u);
  assert.equal(existsSync(marker), false);
  assert.match(f.read("dist/__site/custom/assets/custom.js"), /writeFileSync/u);
});

test("accepts an empty catalog and a complete public purchase configuration without modifying either", () => {
  const empty = structuredClone(defaults);
  assert.equal(validateSiteConfig(empty), empty);
  const purchase = purchaseConfig();
  purchase.apiBaseUrl = "https://license.example.com/nested/api/v1";
  purchase.supportUrl = "mailto:help@example.com";
  assert.equal(validateSiteConfig(purchase), purchase);
  assert.equal(validateSiteConfig({ ...empty, apiBaseUrl: "http://localhost:8787/api/v1" }).products.length, 0);
  for (const supportUrl of ["/help/", "/help/?lang=en#contact", "https://help.example.com/faq?product=desktop#license", "mailto:help@example.com?subject=License%20help"]) {
    assert.equal(validateSiteConfig({ ...empty, supportUrl }).supportUrl, supportUrl);
  }
});

test("rejects mismatched payment environments, duplicate products, missing payment settings and server credentials", () => {
  const wrongEnvironment = purchaseConfig();
  wrongEnvironment.paddle.environment = "live";
  assert.throws(() => validateSiteConfig(wrongEnvironment), /matching the selected environment/u);
  const duplicate = purchaseConfig();
  duplicate.products.push(structuredClone(duplicate.products[0]));
  assert.throws(() => validateSiteConfig(duplicate), /must be unique/u);
  const missingPaddle = purchaseConfig();
  missingPaddle.paddle = null;
  assert.throws(() => validateSiteConfig(missingPaddle), /required when products/u);
  assert.throws(() => validateSiteConfig({ ...structuredClone(defaults), apiKey: "a-private-key" }), (error) => {
    assert.ok(error instanceof SiteConfigError);
    assert.equal(error.message.includes("a-private-key"), false);
    assert.match(error.message, /not a supported public/u);
    return true;
  });
});

test("rejects executable links, network-relative APIs and credential-bearing API addresses", () => {
  for (const apiBaseUrl of ["javascript:alert(1)", "//evil.example/api/v1", "https://user:password@license.example.com/api/v1", "https://license.example.com/api/v1?secret=1", "/api/v1#fragment", "/api/../v1", "/api/%2e%2e/v1", "http://public.example/api/v1"]) {
    assert.throws(() => validateSiteConfig({ ...structuredClone(defaults), apiBaseUrl }), SiteConfigError);
  }
  assert.throws(() => validateSiteConfig({ ...structuredClone(defaults), supportUrl: "javascript:alert(1)" }), SiteConfigError);
});

test("rejects an oversized selected public configuration before replacing the previous output", (t) => {
  const f = fixture(t);
  buildSite({ projectRoot: f.root });
  f.put("apps/site/custom/site.json", " ".repeat(128 * 1024 + 1));
  assert.throws(() => buildSite({ projectRoot: f.root }), /custom\/site\.json.*128 KiB/u);
  assert.equal(f.read("dist/__site/builtin/index.html"), "builtin home");
});

test("development watcher propagates nested additions, edits, file deletions and directory deletions", async (t) => {
  const f = fixture(t);
  buildSite({ projectRoot: f.root });
  let pending;
  const watcher = watchSite({
    projectRoot: f.root,
    debounceMs: 25,
    intervalMs: 25,
    onBuild(result) { pending?.resolve(result); pending = null; },
    onError(error) { pending?.reject(error); pending = null; },
  });
  t.after(() => watcher.close());
  function nextBuild() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending = null; reject(new Error("Site watcher did not publish the source change.")); }, 3000);
      pending = {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); },
      };
    });
  }
  const added = nextBuild();
  const source = f.put("apps/site/custom/help/index.html", "new help page");
  await added;
  assert.equal(f.read("dist/__site/custom/help/index.html"), "new help page");
  const edited = nextBuild();
  writeFileSync(source, "updated help page");
  await edited;
  assert.equal(f.read("dist/__site/custom/help/index.html"), "updated help page");
  const deleted = nextBuild();
  rmSync(source);
  await deleted;
  assert.equal(existsSync(join(f.root, "dist/__site/custom/help/index.html")), false);
  assert.equal(f.read("dist/__site/builtin/index.html"), "builtin home");
  const directoryAdded = nextBuild();
  f.put("apps/site/custom/help/deep/index.html", "nested help");
  await directoryAdded;
  assert.equal(f.read("dist/__site/custom/help/deep/index.html"), "nested help");
  const directoryDeleted = nextBuild();
  rmSync(join(f.root, "apps/site/custom/help"), { recursive: true });
  await directoryDeleted;
  assert.equal(existsSync(join(f.root, "dist/__site/custom/help")), false);
});

test("development watcher reports a bad config and stops watching instead of silently accepting it", async (t) => {
  const f = fixture(t);
  buildSite({ projectRoot: f.root });
  let watcher;
  const failure = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Site watcher did not report the invalid configuration.")), 3000);
    watcher = watchSite({
      projectRoot: f.root,
      intervalMs: 25,
      debounceMs: 25,
      onBuild() { clearTimeout(timeout); reject(new Error("An invalid configuration must not be published.")); },
      onError(error) { clearTimeout(timeout); resolve(error); },
    });
  });
  t.after(() => watcher.close());
  f.put("apps/site/custom/site.json", JSON.stringify({ name: "Incomplete config" }));
  const error = await failure;
  assert.match(error.message, /custom\/site\.json.*required/u);
  assert.equal(existsSync(join(f.root, "dist/__site/custom/site.json")), false);
  assert.equal(f.read("dist/__site/builtin/index.html"), "builtin home");
});
