import assert from "node:assert/strict";
import test from "node:test";

class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.classList = { add: () => {} };
    this.dataset = {};
    this.value = "";
    this.ownText = "";
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.ownText = ""; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  querySelector(selector) { return this.children.find((child) => child.tagName === selector) ?? this.children.map((child) => child.querySelector?.(selector)).find(Boolean) ?? null; }
  focus() {}
  click() { if (!this.disabled) this.listeners.get("click")?.({ preventDefault() {} }); }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(condition) {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise(setImmediate);
  }
  assert.fail("The expected customer page state did not appear");
}
function findButton(root, label) {
  if (root.tagName === "button" && root.textContent === label) return root;
  for (const child of root.children) {
    if (typeof child === "string") continue;
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

test("a stalled subscription does not block the license, and stale devices cannot undo a successful reset", async () => {
  const ids = ["license-core", "devices-content", "subscription-content", "license-actions", "new-key", "page-error", "action-error", "reload-license", "devices-section", "subscription-section"];
  const nodes = new Map(ids.map((id) => [`#${id}`, new Element()]));
  const windowEvents = new Map();
  const subscriptionRead = deferred();
  const oldDeviceRead = deferred();
  const pendingCopy = deferred();
  let clipboardValue = null;
  const original = new Map(["document", "window", "location", "navigator", "localStorage", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const origin = "https://site.example.test";
  let deviceReads = 0;
  let resets = 0;
  let recoveryMode = "forbidden";
  let recoveries = 0;
  const configuration = { name: "License shop", description: "", supportUrl: null, apiBaseUrl: "/api/v1", paddle: null, products: [] };
  const license = { id: "license-1", product_name: "Example App", status: "active", license_model: "perpetual", renewal_mode: "none", credential_mode: "opaque", max_activations: 2, features: ["PDF export", "Offline access"], expires_at: null, updates_until: null };
  const success = (data) => Response.json({ success: true, data });
  const document = {
    body: { dataset: { page: "customer" } }, documentElement: { lang: "en-US" },
    querySelector: (selector) => nodes.get(selector), querySelectorAll: () => [],
    createElement: (tag) => new Element(tag), addEventListener() {}, title: "",
  };
  const location = { origin, href: `${origin}/customer/licenses/license-1`, pathname: "/customer/licenses/license-1", assign() {}, reload() {} };
  const values = {
    document, location,
    window: { location, addEventListener: (name, listener) => windowEvents.set(name, listener) },
    navigator: { languages: ["en-US"], clipboard: { writeText: (value) => { clipboardValue = value; return pendingCopy.promise; } } },
    localStorage: { getItem: () => "en-US", setItem: () => assert.fail("License results must not be stored") },
    fetch: async (input, options) => {
      const url = new URL(input, origin);
      if (url.pathname === "/site.json") return Response.json(configuration);
      if (url.pathname.endsWith("/csrf-token")) return success({ csrf_token: "memory-token" });
      if (url.pathname.endsWith("/security-reset")) { resets += 1; return success({ license_key: resets === 1 ? "new-key-result" : "replacement-key-result", delivery: { status: "failed" } }); }
      if (url.pathname.endsWith("/recover-key")) {
        recoveries += 1;
        if (recoveryMode === "lost") throw new Error("The committed response was lost");
        return Response.json({ success: false, error: { code: "CUSTOMER_CSRF_TOKEN_MISMATCH", message: "Verification failed" } }, { status: 403 });
      }
      if (url.pathname.endsWith("/activations")) {
        deviceReads += 1;
        return deviceReads === 1 ? oldDeviceRead.promise : success({ items: [{ id: "device-1", name: "My laptop", status: "revoked" }] });
      }
      if (url.pathname.endsWith("/subscription")) return subscriptionRead.promise;
      assert.equal(options.method, "GET");
      return success(license);
    },
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  try {
    await import("../builtin/assets/customer-license.js");
    await until(() => deviceReads === 1);
    assert.match(nodes.get("#license-core").textContent, /Example App/);
    assert.equal(nodes.get("#reload-license").disabled, false);
    const reset = findButton(nodes.get("#license-actions"), "Replace key and revoke all devices");
    assert.ok(reset);
    assert.equal(reset.disabled, false);
    const featureList = nodes.get("#license-core").querySelector("ul");
    assert.deepEqual(featureList.children.map((item) => [item.tagName, item.textContent]), [["li", "PDF export"], ["li", "Offline access"]]);
    assert.doesNotMatch(featureList.textContent, /[01]/);
    reset.click();
    await until(() => deviceReads === 2 && nodes.get("#new-key").textContent.includes("Your new license key is ready"));
    assert.equal(resets, 1);
    assert.match(nodes.get("#new-key").textContent, /still copy your new key/);
    assert.equal(nodes.get("#action-error").hidden, true);
    assert.equal(findButton(nodes.get("#devices-content"), "Release device"), null);

    oldDeviceRead.resolve(success({ items: [{ id: "device-1", name: "My laptop", status: "active" }] }));
    subscriptionRead.resolve(Response.json({ success: false, error: { code: "BILLING_PROVIDER_UNAVAILABLE", message: "Subscription unavailable" } }, { status: 503 }));
    await until(() => nodes.get("#subscription-content").textContent.includes("BILLING_PROVIDER_UNAVAILABLE"));
    assert.equal(findButton(nodes.get("#devices-content"), "Release device"), null);
    assert.match(nodes.get("#license-core").textContent, /Example App/);
    assert.equal(nodes.get("#new-key").hidden, false);
    assert.equal(resets, 1);

    // A delayed copy of the first key must not mark its replacement as copied.
    findButton(nodes.get("#new-key"), "Copy license key").click();
    assert.equal(clipboardValue, "new-key-result");
    findButton(nodes.get("#license-actions"), "Replace key and revoke all devices").click();
    await until(() => nodes.get("#new-key").querySelector("textarea")?.value === "replacement-key-result");
    pendingCopy.resolve();
    await new Promise(setImmediate);
    assert.equal(clipboardValue, "new-key-result");
    assert.equal(findButton(nodes.get("#new-key"), "Copied"), null);
    assert.ok(findButton(nodes.get("#new-key"), "Copy license key"));

    // A known rejection leaves the previously generated result available.
    findButton(nodes.get("#license-actions"), "Generate a new key").click();
    await until(() => nodes.get("#action-error").textContent.includes("CUSTOMER_CSRF_TOKEN_MISMATCH"));
    assert.equal(nodes.get("#new-key").hidden, false);
    assert.equal(nodes.get("#new-key").querySelector("textarea").value, "replacement-key-result");

    // The second write may have committed. The old key must no longer be offered.
    recoveryMode = "lost";
    findButton(nodes.get("#license-actions"), "Generate a new key").click();
    await until(() => nodes.get("#action-error").textContent.includes("CUSTOMER_NETWORK_ERROR"));
    assert.equal(recoveries, 2);
    assert.equal(nodes.get("#new-key").hidden, true);
    assert.equal(nodes.get("#new-key").querySelector("textarea"), null);
    assert.equal(findButton(nodes.get("#license-actions"), "Generate a new key").disabled, true);

    windowEvents.get("pagehide")();
    assert.equal(nodes.get("#new-key").hidden, true);
    assert.equal(nodes.get("#new-key").children.length, 0);
  } finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
