import test from "node:test";
import assert from "node:assert/strict";
import { openCheckout } from "../builtin/assets/checkout.js";
import { text } from "../builtin/assets/i18n.js";

function config(environment = "sandbox") {
  return {
    name: "Test product", description: "", supportUrl: null, apiBaseUrl: "/api/v1",
    paddle: { environment, clientSideToken: environment === "sandbox" ? "test_public" : "live_public" },
    products: [{ id: "app", name: "App", description: "", plans: [{ name: "One-time", description: "", price: "$19", priceId: "pri_test" }] }],
  };
}

function runtime() {
  const calls = { environments: [], initialize: [], checkout: [] };
  const paddle = {
    Environment: { set(value) { calls.environments.push(value); } },
    Initialize(options) { calls.initialize.push(options); },
    Checkout: { open(options) { calls.checkout.push(options); } },
  };
  return { paddle, calls };
}

test("opens only the selected configured Price once per purchase, with a same-origin result URL", async () => {
  const { paddle, calls } = runtime();
  const options = { loadPaddle: async () => paddle, location: { origin: "https://shop.example.test" } };
  await openCheckout(config(), "pri_test", "en-US", options);
  await openCheckout(config(), "pri_test", "zh-CN", options);
  assert.deepEqual(calls.environments, ["sandbox"]);
  assert.equal(calls.initialize.length, 1);
  assert.deepEqual(calls.checkout[0].items, [{ priceId: "pri_test", quantity: 1 }]);
  assert.equal(calls.checkout[0].settings.successUrl, "https://shop.example.test/purchase-success");
  assert.equal(calls.checkout[1].settings.locale, "zh-Hans");
});

test("does not load payment code for an unconfigured Price or a site without products", async () => {
  let loads = 0;
  const options = { loadPaddle: async () => { loads++; return runtime().paddle; }, location: { origin: "https://shop.example.test" } };
  await assert.rejects(openCheckout(config(), "pri_other", "en-US", options), /PADDLE_PRICE_INVALID/u);
  await assert.rejects(openCheckout({ ...config(), products: [], paddle: null }, "pri_test", "en-US", options), /PADDLE_PRICE_INVALID/u);
  assert.equal(loads, 0);
});

test("permits HTTP only for a local Sandbox and rejects public HTTP and live HTTP", async () => {
  const { paddle } = runtime();
  const loadPaddle = async () => paddle;
  await openCheckout(config(), "pri_test", "en-US", { loadPaddle, location: { origin: "http://localhost:8787" } });
  await assert.rejects(openCheckout(config(), "pri_test", "en-US", { loadPaddle, location: { origin: "http://shop.example.test" } }), /PADDLE_ORIGIN_INVALID/u);
  await assert.rejects(openCheckout(config("live"), "pri_test", "en-US", { loadPaddle, location: { origin: "http://localhost:8787" } }), /PADDLE_ORIGIN_INVALID/u);
});

test("rejects environment changes instead of reinitializing an existing payment runtime", async () => {
  const { paddle, calls } = runtime();
  const options = { loadPaddle: async () => paddle, location: { origin: "https://shop.example.test" } };
  await openCheckout(config(), "pri_test", "en-US", options);
  await assert.rejects(openCheckout(config("live"), "pri_test", "en-US", options), /PADDLE_CONFIGURATION_CHANGED/u);
  assert.equal(calls.initialize.length, 1);
  assert.equal(calls.checkout.length, 1);
});

test("surfaces a payment load failure and allows an explicit subsequent attempt", async () => {
  const { paddle, calls } = runtime();
  let attempts = 0;
  const options = { loadPaddle: async () => { if (++attempts === 1) throw new Error("network unavailable"); return paddle; }, location: { origin: "https://shop.example.test" } };
  await assert.rejects(openCheckout(config(), "pri_test", "en-US", options), /network unavailable/u);
  await openCheckout(config(), "pri_test", "en-US", options);
  assert.equal(attempts, 2);
  assert.equal(calls.checkout.length, 1);
});

test("both languages retain the purchase-result uncertainty and actionable empty catalog", () => {
  assert.match(text("resultNote", "en-US"), /does not confirm payment/u);
  assert.match(text("resultNote", "zh-CN"), /不代表付款成功/u);
  assert.match(text("noProductsBody", "en-US"), /sign in/u);
  assert.match(text("noProductsBody", "zh-CN"), /登录/u);
});
