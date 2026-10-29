import { takeLoginToken, createCustomerApi } from "./api.js";
import { initSite, getLocale } from "./site.js";
import { clearError } from "./ui.js";
import { ct, localizeCustomer, customerError } from "./customer-common.js";

// Do this before configuration requests or any interaction. Never persist the token.
let token = takeLoginToken(window.location, window.history);
const confirm = document.querySelector("#confirm-login");
const invalid = document.querySelector("#invalid-link");
const errorPanel = document.querySelector("#page-error");
let context;
let api;
let busy = false;
let currentError = null;

function render() {
  const locale = context?.locale ?? getLocale();
  localizeCustomer(locale);
  document.title = `${ct("authTitle", locale)}${context ? ` · ${context.config.name}` : ""}`;
  confirm.textContent = ct(busy ? "loggingIn" : "confirmLogin", locale);
  confirm.disabled = busy || !token || !api;
  invalid.hidden = Boolean(token) || busy;
  if (currentError) customerError(errorPanel, currentError, locale, { writing: true, unknownMessage: "authUnknown" });
}

confirm.addEventListener("click", async () => {
  if (busy || !token || !api) return;
  const submittedToken = token;
  token = null;
  busy = true;
  currentError = null;
  clearError(errorPanel);
  render();
  try {
    const result = await api.post("/customer/auth/magic-link/consume", { token: submittedToken }, { csrf: false });
    if (result?.authenticated !== true) throw new Error("The sign-in response could not be confirmed.");
    api.setCsrfToken(result.csrf_token);
    window.location.assign("/customer/");
  } catch (error) {
    currentError = error;
    busy = false;
    render();
  }
});

document.addEventListener("site:localechange", render);
window.addEventListener("pagehide", () => { token = null; api?.clear(); render(); });
render();
initSite().then((value) => { context = value; api = createCustomerApi(context.config.apiBaseUrl); render(); })
  .catch((error) => { currentError = error; render(); });
