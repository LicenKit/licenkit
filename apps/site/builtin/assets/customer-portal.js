import { initSite, getLocale } from "./site.js";
import { createCustomerApi, CustomerApiError, isLoginRequired } from "./api.js";
import { el, clearError } from "./ui.js";
import { ct, localizeCustomer, customerError, dateText, statusText, row } from "./customer-common.js";

const errorPanel = document.querySelector("#page-error");
const account = document.querySelector("#customer-account");
const list = document.querySelector("#licenses");
const refresh = document.querySelector("#reload-licenses");
const logout = document.querySelector("#logout");
let context;
let api;
let customer = null;
let licenses = null;
let loading = true;
let signingOut = false;
let currentError = null;
let errorWriting = false;

function render() {
  const locale = context?.locale ?? getLocale();
  localizeCustomer(locale);
  document.title = `${ct("portalTitle", locale)}${context ? ` · ${context.config.name}` : ""}`;
  refresh.disabled = loading || signingOut;
  logout.disabled = !customer || loading || signingOut;
  logout.textContent = ct(signingOut ? "loggingOut" : "logout", locale);
  account.replaceChildren(...(customer ? [el("span", { className: "muted", text: ct("account", locale) }), el("strong", { text: customer.email })] : []));
  if (loading && licenses === null) list.replaceChildren(el("p", { role: "status", text: ct("loading", locale) }));
  else if (licenses) {
    list.replaceChildren();
    if (!licenses.length) list.append(el("div", { className: "empty-state" }, el("h2", { text: ct("noLicenses", locale) }), el("p", { text: ct("noLicensesHint", locale) }), el("a", { className: "button button-secondary", href: "/pricing", text: ct("viewPrices", locale) })));
    for (const license of licenses) {
      const card = el("article", { className: "card stack" },
        el("div", { className: "section-heading" }, el("h2", { text: license.product_name }), el("span", { className: "status-badge", text: statusText(license.status, locale) })),
        el("dl", { className: "details-list" }, row(ct("type", locale), statusText(license.license_model, locale)), row(ct("expires", locale), dateText(license.expires_at, locale, "noExpiry"))),
        el("a", { className: "button button-secondary", href: `/customer/licenses/${encodeURIComponent(license.id)}`, text: ct("details", locale) }));
      if (license.billing_environment === "sandbox") card.prepend(el("p", { className: "eyebrow", text: ct("sandbox", locale) }));
      list.append(card);
    }
  } else list.replaceChildren();
  if (currentError) customerError(errorPanel, currentError, locale, { writing: errorWriting, unknownMessage: "logoutUnknown" });
}

async function load() {
  if (!api || signingOut) return;
  loading = true;
  errorWriting = false;
  currentError = null;
  clearError(errorPanel);
  render();
  try {
    const [me, result] = await Promise.all([api.get("/customer/me"), api.get("/customer/licenses")]);
    if (typeof me?.email !== "string" || !Array.isArray(result?.items)) throw new CustomerApiError("The license information is incomplete.", { code: "CUSTOMER_RESPONSE_INVALID" });
    customer = me;
    licenses = result.items;
  } catch (error) {
    currentError = error;
    if (isLoginRequired(error)) { customer = null; licenses = null; }
  } finally { loading = false; render(); }
}

refresh.addEventListener("click", () => { if (!loading) void load(); });
logout.addEventListener("click", async () => {
  if (!api || signingOut || !customer) return;
  signingOut = true;
  errorWriting = true;
  currentError = null;
  clearError(errorPanel);
  render();
  try {
    await api.post("/customer/auth/logout");
    api.clear();
    customer = null;
    licenses = null;
    window.location.assign("/customer/login");
  } catch (error) { currentError = error; signingOut = false; render(); }
});

document.addEventListener("site:localechange", render);
window.addEventListener("pagehide", () => { api?.clear(); customer = null; licenses = null; });
render();
initSite().then((value) => { context = value; api = createCustomerApi(context.config.apiBaseUrl); return load(); })
  .catch((error) => { currentError = error; loading = false; render(); });
