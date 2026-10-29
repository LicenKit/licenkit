import { validateSiteConfig } from "./config.js";

let loading;
const initialized = new WeakMap();

export function loadOfficialPaddle() {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
      script.async = true;
      const timeout = setTimeout(() => finish(new Error("PADDLE_LOAD_TIMEOUT: The payment window did not load. Please try again.")), 20000);
      function finish(error) {
        clearTimeout(timeout);
        script.onload = null;
        script.onerror = null;
        if (error) { script.remove(); reject(error); }
        else resolve(window.Paddle);
      }
      script.onload = () => finish(window.Paddle ? null : new Error("PADDLE_LOAD_FAILED: The payment service is unavailable."));
      script.onerror = () => finish(new Error("PADDLE_LOAD_FAILED: Could not load the payment service."));
      document.head.appendChild(script);
    }).catch((error) => { loading = undefined; throw error; });
  }
  return loading;
}

/** A browser-only purchase: one configured Price, quantity one, no public checkout API. */
export async function openCheckout(config, priceId, locale, { loadPaddle = loadOfficialPaddle, location: currentLocation = globalThis.location } = {}) {
  validateSiteConfig(config);
  if (!config.paddle || !config.products.some((product) => product.plans.some((plan) => plan.priceId === priceId))) {
    throw new Error("PADDLE_PRICE_INVALID: This purchase plan is unavailable.");
  }
  const successUrl = new URL("/purchase-success", currentLocation.origin);
  const localSandbox = config.paddle.environment === "sandbox" && successUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(successUrl.hostname);
  if (successUrl.protocol !== "https:" && !localSandbox) throw new Error("PADDLE_ORIGIN_INVALID: Purchases require an HTTPS website.");
  const paddle = await loadPaddle();
  if (typeof paddle?.Initialize !== "function" || typeof paddle?.Checkout?.open !== "function") throw new Error("PADDLE_LOAD_FAILED: The payment service is unavailable.");
  const identity = `${config.paddle.environment}:${config.paddle.clientSideToken}`;
  if (initialized.has(paddle) && initialized.get(paddle) !== identity) throw new Error("PADDLE_CONFIGURATION_CHANGED: Reload the page before purchasing.");
  if (!initialized.has(paddle)) {
    if (config.paddle.environment === "sandbox") {
      if (typeof paddle.Environment?.set !== "function") throw new Error("PADDLE_ENVIRONMENT_INVALID: Could not select the test payment environment.");
      paddle.Environment.set("sandbox");
    }
    paddle.Initialize({ token: config.paddle.clientSideToken });
    initialized.set(paddle, identity);
  }
  paddle.Checkout.open({ items: [{ priceId, quantity: 1 }], settings: { displayMode: "overlay", theme: "light", locale: locale === "zh-CN" ? "zh-Hans" : "en", successUrl: successUrl.href } });
}
