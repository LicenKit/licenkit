import test from "node:test";
import assert from "node:assert/strict";

let pageCounter = 0;

async function withPage(description, run) {
  const original = new Map();
  const defaultIntro = { dataset: { i18n: "homeIntro" }, textContent: "" };
  const brand = { textContent: "" };
  const handlers = new Map();
  const select = { value: "en-US", addEventListener(event, handler) { handlers.set(event, handler); } };
  const dispatched = [];
  const doc = {
    documentElement: { lang: "" }, body: { dataset: { page: "home" } },
    querySelectorAll(selector) {
      return ({ "[data-i18n]": [defaultIntro], "[data-site-description]": [defaultIntro], "[data-site-name]": [brand], "[data-locale-select]": [select] })[selector] ?? [];
    },
    dispatchEvent(event) { dispatched.push(event); },
  };
  const globals = {
    document: doc, navigator: { language: "en-US" }, location: { pathname: "/" },
    localStorage: { getItem() { return null; }, setItem() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    fetch: async () => ({ ok: true, async json() { return { name: "A real brand", description, supportUrl: null, apiBaseUrl: "/api/v1", paddle: null, products: [] }; } }),
  };
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    const site = await import(`../builtin/assets/site.js?bootstrap=${++pageCounter}`);
    const context = await site.initSite();
    await run({ context, description: defaultIntro, brand, select, handlers, doc, dispatched });
  } finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("a configured brand description remains authoritative when changing page language", async () => {
  await withPage("Custom product description", ({ context, description, brand, select, handlers, doc, dispatched }) => {
    assert.equal(description.textContent, "Custom product description");
    select.value = "zh-CN";
    handlers.get("change")();
    assert.equal(description.textContent, "Custom product description");
    assert.equal(brand.textContent, "A real brand");
    assert.equal(context.locale, "zh-CN");
    assert.equal(doc.documentElement.lang, "zh-CN");
    assert.deepEqual(dispatched.map((event) => [event.type, event.detail.locale]), [["site:localechange", "zh-CN"]]);
  });
});

test("an empty description uses the localized default instead of staying blank", async () => {
  await withPage("", ({ description, select, handlers }) => {
    assert.match(description.textContent, /Explore our products/u);
    select.value = "zh-CN";
    handlers.get("change")();
    assert.match(description.textContent, /了解我们的产品/u);
  });
});
