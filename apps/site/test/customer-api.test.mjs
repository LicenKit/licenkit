import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerApi, takeLoginToken, isLoginRequired, validatePortalUrl } from "../builtin/assets/api.js";
import { deliveryText } from "../builtin/assets/customer-common.js";

function success(data) { return Response.json({ success: true, data }); }

test("login fragment is cleared immediately and duplicate or missing tokens are rejected", () => {
  const calls = [];
  const history = { replaceState: (...args) => calls.push(args) };
  const token = "a".repeat(48);
  assert.equal(takeLoginToken({ pathname: "/customer/auth", search: "?lang=en-US", hash: `#token=${token}` }, history), token);
  assert.deepEqual(calls, [[null, "", "/customer/auth?lang=en-US"]]);
  assert.equal(takeLoginToken({ pathname: "/customer/auth", search: "", hash: `#token=${token}&token=${token}` }, history), null);
  assert.equal(takeLoginToken({ pathname: "/customer/auth", search: "", hash: "#token=short" }, history), null);
  assert.equal(takeLoginToken({ pathname: "/customer/auth", search: "", hash: "" }, history), null);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => !call[2].includes("token")));
});

test("concurrent writes retrieve one CSRF token and include credentials without persisting it", async () => {
  const calls = [];
  const api = createCustomerApi("/api/v1", {
    origin: "https://site.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.pathname.endsWith("/csrf-token") ? success({ csrf_token: "in-memory-csrf" }) : success({ id: "activation-1", status: "deactivated" });
    },
  });
  await Promise.all([
    api.post("/customer/licenses/license-1/activations/device-1/deactivate"),
    api.post("/customer/licenses/license-1/activations/device-2/deactivate"),
  ]);
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/csrf-token")).length, 1);
  for (const call of calls) {
    assert.equal(call.options.credentials, "include");
    assert.equal(call.options.cache, "no-store");
    assert.equal(call.options.referrerPolicy, "no-referrer");
  }
  const writes = calls.filter((call) => call.options.method === "POST");
  assert.equal(writes.length, 2);
  assert.ok(writes.every((call) => call.options.headers.get("X-CSRF-Token") === "in-memory-csrf"));
  assert.ok(writes.every((call) => call.options.body === "{}"));
});

test("email-link requests and consumption do not need a previous customer session", async () => {
  const calls = [];
  const api = createCustomerApi("https://license.example.test/api/v1", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return success({ authenticated: true, csrf_token: "returned-by-consume" });
    },
  });
  const result = await api.post("/customer/auth/magic-link/consume", { token: "one-time-token" }, { csrf: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://license.example.test/api/v1/customer/auth/magic-link/consume");
  assert.equal(calls[0].options.headers.get("X-CSRF-Token"), null);
  api.setCsrfToken(result.csrf_token);
  await api.post("/customer/auth/logout");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.get("X-CSRF-Token"), "returned-by-consume");
});

test("a CSRF rejection keeps its code and request id and never retries the write", async () => {
  let calls = 0;
  const api = createCustomerApi("/api/v1", {
    origin: "https://site.example.test",
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ success: false, error: { code: "CUSTOMER_CSRF_TOKEN_MISMATCH", message: "Verification failed", request_id: "req_customer" } }, { status: 403 });
    },
  });
  api.setCsrfToken("memory-token");
  await assert.rejects(api.post("/customer/licenses/license-1/security-reset"), (error) => {
    assert.equal(error.code, "CUSTOMER_CSRF_TOKEN_MISMATCH");
    assert.equal(error.requestId, "req_customer");
    assert.equal(error.outcomeUnknown, false);
    assert.equal(isLoginRequired(error), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("transport failure after a write is an unknown outcome and is not retried", async () => {
  let calls = 0;
  const api = createCustomerApi("/api/v1", {
    origin: "https://site.example.test",
    fetchImpl: async () => { calls += 1; throw new Error("network unavailable"); },
  });
  api.setCsrfToken("memory-token");
  await assert.rejects(api.post("/customer/licenses/license-1/recover-key"), (error) => error.code === "CUSTOMER_NETWORK_ERROR" && error.outcomeUnknown);
  assert.equal(calls, 1);
});

test("CSRF bootstrap failure cannot send the business mutation", async () => {
  const methods = [];
  const api = createCustomerApi("/api/v1", {
    origin: "https://site.example.test",
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return Response.json({ success: false, error: { code: "UNAUTHORIZED", message: "Sign in again" } }, { status: 401 });
    },
  });
  await assert.rejects(api.post("/customer/licenses/license-1/security-reset"), isLoginRequired);
  assert.deepEqual(methods, ["GET"]);
});

test("configuration and Origin failures are not converted to expired sessions", () => {
  assert.equal(isLoginRequired({ status: 403, code: "CUSTOMER_ORIGIN_NOT_ALLOWED" }), false);
  assert.equal(isLoginRequired({ status: 503, code: "TURNSTILE_CONFIGURATION_ERROR" }), false);
  assert.equal(isLoginRequired({ status: 401, code: "UNAUTHORIZED" }), true);
  assert.equal(isLoginRequired({ status: 401, code: "CUSTOMER_RECENT_AUTH_REQUIRED" }), true);
});

test("unreadable successful mutation responses stay unknown rather than claiming failure or success", async () => {
  const api = createCustomerApi("/api/v1", { origin: "https://site.example.test", fetchImpl: async () => new Response("not json") });
  api.setCsrfToken("memory-token");
  await assert.rejects(api.post("/customer/licenses/license-1/recover-key"), (error) => error.code === "CUSTOMER_RESPONSE_INVALID" && error.outcomeUnknown);
});

test("payment management redirects only accept absolute HTTPS addresses without credentials", () => {
  assert.equal(validatePortalUrl("https://customer-portal.paddle.com/session?token=short-lived"), "https://customer-portal.paddle.com/session?token=short-lived");
  for (const url of ["javascript:alert(1)", "http://example.test", "https://user:pass@example.test", "/relative"]) assert.throws(() => validatePortalUrl(url));
});

test("delivery feedback distinguishes accepted mail from delivery and never hides the generated key", () => {
  assert.match(deliveryText("accepted", "zh-CN"), /服务商已接收/);
  assert.doesNotMatch(deliveryText("accepted", "zh-CN"), /已送达/);
  assert.match(deliveryText("failed", "en-US"), /still copy your new key/);
  assert.match(deliveryText("waiting_configuration", "zh-CN"), /仍可以复制新注册码/);
});
