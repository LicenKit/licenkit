import { initSite, getLocale } from "./site.js";
import { createCustomerApi, CustomerApiError } from "./api.js";
import { clearError } from "./ui.js";
import { ct, localizeCustomer, customerError } from "./customer-common.js";

const form = document.querySelector("#login-form");
const button = document.querySelector("#send-link");
const errorPanel = document.querySelector("#page-error");
const acceptedPanel = document.querySelector("#login-accepted");
let context;
let token = null;
let widgetId = null;
let busy = false;
let currentError = null;

function render() {
  const locale = context?.locale ?? getLocale();
  localizeCustomer(locale);
  document.title = `${ct("loginTitle", locale)}${context ? ` · ${context.config.name}` : ""}`;
  button.textContent = ct(busy ? "sending" : "sendLink", locale);
  button.disabled = busy || !token;
  if (currentError) customerError(errorPanel, currentError, locale, { unknownMessage: "loginUnknown" });
}

async function loadTurnstile() {
  if (window.turnstile) return window.turnstile;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new CustomerApiError("Verification is unavailable.", { code: "TURNSTILE_VERIFICATION_UNAVAILABLE" }));
    script.onerror = () => reject(new CustomerApiError("Verification is unavailable.", { code: "TURNSTILE_VERIFICATION_UNAVAILABLE" }));
    document.head.append(script);
  });
}

async function main() {
  context = await initSite();
  const api = createCustomerApi(context.config.apiBaseUrl);
  render();
  const configuration = await api.get("/customer/auth/config");
  if (typeof configuration?.turnstile_site_key !== "string" || !configuration.turnstile_site_key) throw new CustomerApiError("Verification is not configured.", { code: "TURNSTILE_CONFIGURATION_ERROR" });
  const turnstile = await loadTurnstile();
  widgetId = turnstile.render(document.querySelector("#verification"), {
    sitekey: configuration.turnstile_site_key, action: "customer_magic_link", theme: "light",
    language: context.locale === "zh-CN" ? "zh-cn" : "en",
    callback: (value) => { token = value; currentError = null; clearError(errorPanel); render(); },
    "expired-callback": () => { token = null; render(); },
    "error-callback": () => {
      token = null;
      currentError = new CustomerApiError("Verification is unavailable.", { code: "TURNSTILE_VERIFICATION_UNAVAILABLE" });
      render();
    },
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !token || !form.reportValidity()) return;
    busy = true;
    currentError = null;
    clearError(errorPanel);
    render();
    try {
      const result = await api.post("/customer/auth/magic-link", {
        email: form.elements.email.value.trim(), turnstile_token: token,
      }, { csrf: false });
      if (result?.accepted !== true) throw new CustomerApiError("The sign-in request could not be confirmed.", { code: "CUSTOMER_RESPONSE_INVALID", outcomeUnknown: true });
      acceptedPanel.hidden = false;
      acceptedPanel.focus();
    } catch (error) {
      currentError = error;
    } finally {
      token = null;
      busy = false;
      turnstile.reset(widgetId);
      render();
    }
  });
}

document.addEventListener("site:localechange", render);
window.addEventListener("pagehide", () => { token = null; });
render();
main().catch((error) => { currentError = error; render(); });
