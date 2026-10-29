import { initSite, getLocale } from "./site.js";
import { createCustomerApi, CustomerApiError, validatePortalUrl } from "./api.js";
import { el, clearError } from "./ui.js";
import { ct, localizeCustomer, customerError, dateText, statusText, deliveryText, row } from "./customer-common.js";

const corePanel = document.querySelector("#license-core");
const devicesPanel = document.querySelector("#devices-content");
const subscriptionPanel = document.querySelector("#subscription-content");
const actionsPanel = document.querySelector("#license-actions");
const keyPanel = document.querySelector("#new-key");
const pageError = document.querySelector("#page-error");
const actionError = document.querySelector("#action-error");
const refresh = document.querySelector("#reload-license");
const match = window.location.pathname.match(/^\/customer\/licenses\/([A-Za-z0-9_-]+)\/?$/u);
let context;
let api;
let license = null;
let activations = null;
let subscription = null;
let coreError = null;
let devicesError = null;
let subscriptionError = null;
let operationError = null;
let busy = null;
let outcomeUnknown = false;
let loading = true;
let newKey = null;
let deliveryStatus = null;
let copied = false;
let copyFailed = false;
let deviceNotice = false;
let devicesRequest = 0;
let subscriptionRequest = 0;

function apiPath(suffix = "") { return `/customer/licenses/${encodeURIComponent(match[1])}${suffix}`; }
function canWrite() { return Boolean(license && !loading && !busy && !outcomeUnknown); }
function actionButton(label, action, { danger = false, key = action } = {}) {
  const node = el("button", { type: "button", className: `button ${danger ? "button-danger" : "button-secondary"}`, disabled: !canWrite(), text: ct(busy === key ? "working" : label, context.locale) });
  node.addEventListener("click", () => { if (canWrite()) void action(); });
  return node;
}

function renderCore() {
  const locale = context?.locale ?? getLocale();
  if (!license) {
    corePanel.replaceChildren(...(loading ? [el("p", { role: "status", text: ct("loading", locale) })] : []));
    return;
  }
  corePanel.replaceChildren(el("div", { className: "section-heading" }, el("h2", { text: license.product_name }), el("span", { className: "status-badge", text: statusText(license.status, locale) })),
    el("dl", { className: "details-list" },
      row(ct("type", locale), statusText(license.license_model, locale)),
      row(ct("expires", locale), dateText(license.expires_at, locale, "noExpiry")),
      row(ct("updates", locale), dateText(license.updates_until, locale, "notApplicable")),
      row(ct("devicesLimit", locale), String(license.max_activations ?? ct("unknown", locale)))));
  if (license.billing_environment === "sandbox") corePanel.prepend(el("p", { className: "eyebrow", text: ct("sandbox", locale) }));
  if (license.features.length) {
    const features = el("ul", { className: "feature-list" });
    for (const feature of license.features) features.append(el("li", { text: feature }));
    corePanel.append(el("h3", { text: ct("features", locale) }), features);
  }
}

function renderDevices() {
  const locale = context?.locale ?? getLocale();
  devicesPanel.replaceChildren();
  if (activations === null && !devicesError) devicesPanel.append(el("p", { role: "status", text: ct("loading", locale) }));
  if (activations?.length === 0) devicesPanel.append(el("p", { className: "muted", text: ct("noDevices", locale) }));
  for (const device of activations ?? []) {
    const card = el("article", { className: "card stack" },
      el("div", { className: "section-heading" }, el("h3", { text: device.name || ct("device", locale) }), el("span", { className: "status-badge", text: statusText(device.status, locale) })),
      el("dl", { className: "details-list" }, row(ct("platform", locale), device.platform || ct("unknown", locale)), row(ct("activatedAt", locale), dateText(device.activated_at, locale)), row(ct("lastUsed", locale), dateText(device.last_validated_at, locale))));
    if (device.status === "active") {
      const release = el("button", { type: "button", className: "button button-secondary", disabled: !canWrite(), text: ct(busy === device.id ? "deactivating" : "deactivate", locale) });
      release.addEventListener("click", () => { if (canWrite()) void mutate("deactivate", device.id); });
      card.append(release);
    }
    devicesPanel.append(card);
  }
  if (deviceNotice) devicesPanel.prepend(el("p", { className: "notice notice-success", role: "status", text: ct("deactivated", locale) }));
  if (devicesError) {
    const error = el("div");
    customerError(error, devicesError, locale);
    const retry = el("button", { className: "button button-secondary", type: "button", text: ct("retry", locale), disabled: Boolean(busy) });
    retry.addEventListener("click", () => { void loadDevices(); });
    devicesPanel.append(error, retry);
  }
}

function renderSubscription() {
  const locale = context?.locale ?? getLocale();
  subscriptionPanel.replaceChildren();
  if (!subscription && !subscriptionError) subscriptionPanel.append(el("p", { role: "status", text: ct("loading", locale) }));
  if (subscription) {
    const billing = subscription.billing_subscription;
    if (billing) {
      subscriptionPanel.append(el("dl", { className: "details-list" }, row(ct("status", locale), statusText(billing.status, locale)), row(ct("periodEnd", locale), dateText(billing.current_period_end, locale)), row(ct("nextBilled", locale), dateText(billing.next_billed_at, locale))));
      if (billing.cancel_at_period_end) subscriptionPanel.append(el("p", { className: "notice", text: ct("cancelAtEnd", locale) }));
    } else subscriptionPanel.append(el("p", { className: "muted", text: ct(subscription.license_model === "subscription" && subscription.renewal_mode === "manual" ? "manualSubscription" : "noSubscription", locale) }));
    if (subscription.license_model === "subscription" && subscription.renewal_mode === "billing" && billing) subscriptionPanel.append(actionButton("manageSubscription", () => mutate("portal"), { key: "portal" }));
  }
  if (subscriptionError) {
    const error = el("div");
    customerError(error, subscriptionError, locale);
    const retry = el("button", { className: "button button-secondary", type: "button", text: ct("retry", locale), disabled: Boolean(busy) });
    retry.addEventListener("click", () => { void loadSubscription(); });
    subscriptionPanel.append(error, retry);
  }
}

function renderActions() {
  actionsPanel.replaceChildren();
  if (!license || !context) return;
  const locale = context.locale;
  actionsPanel.append(
    el("section", { className: "card stack" }, el("h2", { text: ct("recover", locale) }), el("p", { className: "muted", text: ct("recoverHint", locale) }), actionButton("generate", () => mutate("recover"), { key: "recover" })),
    el("section", { className: "card stack" }, el("h2", { text: ct("reset", locale) }), el("p", { className: "muted", text: ct("resetHint", locale) }), actionButton("resetAction", () => mutate("reset"), { key: "reset", danger: true })));
}

function renderKey() {
  keyPanel.replaceChildren();
  keyPanel.hidden = !newKey;
  if (!newKey || !context) return;
  const locale = context.locale;
  const field = el("textarea", { id: "license-key", readonly: true, rows: 2, autocomplete: "off", spellcheck: "false", "aria-label": ct("keyTitle", locale) });
  field.value = newKey;
  const copy = el("button", { type: "button", className: "button", text: ct(copied ? "copied" : "copy", locale) });
  copy.addEventListener("click", async () => {
    const keySnapshot = newKey;
    let failed = false;
    try { await navigator.clipboard.writeText(keySnapshot); }
    catch { failed = true; }
    if (newKey !== keySnapshot || keyPanel.hidden) return;
    copied = !failed;
    copyFailed = failed;
    renderKey();
  });
  const hide = el("button", { type: "button", className: "button button-secondary", text: ct("hideKey", locale) });
  hide.addEventListener("click", () => { newKey = null; renderKey(); });
  keyPanel.append(el("h2", { text: ct("keyTitle", locale) }), el("p", { text: ct("keyHint", locale) }), field,
    el("div", { className: "inline-actions" }, copy, hide), el("p", { className: "muted", text: deliveryText(deliveryStatus, locale) }));
  if (copyFailed) keyPanel.append(el("p", { role: "status", text: ct("copyFailed", locale) }));
}

function render() {
  const locale = context?.locale ?? getLocale();
  localizeCustomer(locale);
  document.title = `${license?.product_name || ct("detailTitle", locale)}${context ? ` · ${context.config.name}` : ""}`;
  refresh.disabled = loading || Boolean(busy);
  document.querySelector("#devices-section").hidden = !license;
  document.querySelector("#subscription-section").hidden = !license;
  renderCore(); renderDevices(); renderSubscription(); renderActions(); renderKey();
  if (coreError) customerError(pageError, coreError, locale);
  if (operationError) customerError(actionError, operationError, locale, { writing: true });
}

async function loadDevices() {
  const request = ++devicesRequest;
  devicesError = null;
  try {
    const result = await api.get(apiPath("/activations"));
    if (request !== devicesRequest) return;
    if (!Array.isArray(result?.items)) throw new CustomerApiError("The device information is incomplete.", { code: "CUSTOMER_RESPONSE_INVALID" });
    activations = result.items;
  } catch (error) { if (request !== devicesRequest) return; devicesError = error; }
  renderDevices();
}

async function loadSubscription() {
  const request = ++subscriptionRequest;
  subscriptionError = null;
  try {
    const result = await api.get(apiPath("/subscription"));
    if (request !== subscriptionRequest) return;
    if (!result?.license_id) throw new CustomerApiError("The subscription information is incomplete.", { code: "CUSTOMER_RESPONSE_INVALID" });
    subscription = result;
  } catch (error) { if (request !== subscriptionRequest) return; subscriptionError = error; }
  renderSubscription();
}

async function load() {
  if (!api || busy) return;
  loading = true;
  coreError = null;
  clearError(pageError);
  render();
  try {
    if (!match) throw new CustomerApiError("The license address is invalid.", { code: "CUSTOMER_REQUEST_INVALID" });
    const result = await api.get(apiPath());
    if (!result?.id || typeof result.product_name !== "string" || !Array.isArray(result.features) || result.features.some((feature) => typeof feature !== "string")) throw new CustomerApiError("The license information is incomplete.", { code: "CUSTOMER_RESPONSE_INVALID" });
    license = result;
    loading = false;
    render();
    void loadDevices();
    void loadSubscription();
  } catch (error) { coreError = error; license = null; }
  finally { loading = false; render(); }
}

async function mutate(action, deviceId) {
  if (!canWrite()) return;
  busy = deviceId ?? action;
  // Reads started before a mutation cannot overwrite the resulting device state.
  const changesDevices = action === "deactivate" || action === "reset";
  if (changesDevices) devicesRequest += 1;
  operationError = null;
  clearError(actionError);
  render();
  try {
    if (action === "deactivate") {
      await api.post(apiPath(`/activations/${encodeURIComponent(deviceId)}/deactivate`));
      activations = activations.map((device) => device.id === deviceId ? { ...device, status: "deactivated" } : device);
      deviceNotice = true;
    } else if (action === "portal") {
      const result = await api.post(apiPath("/subscription/portal-session"));
      window.location.assign(validatePortalUrl(result?.url));
    } else {
      const result = await api.post(apiPath(action === "recover" ? "/recover-key" : "/security-reset"));
      if (typeof result?.license_key !== "string" || !result.license_key) throw new CustomerApiError("The new key could not be read. Reload before choosing another action.", { code: "CUSTOMER_RESPONSE_INVALID", outcomeUnknown: true });
      newKey = result.license_key;
      deliveryStatus = result.delivery?.status;
      copied = false; copyFailed = false;
      renderKey();
      keyPanel.focus();
      if (action === "reset") await loadDevices();
    }
  } catch (error) {
    operationError = error;
    if (error?.outcomeUnknown) {
      outcomeUnknown = true;
      if (action === "recover" || action === "reset") {
        // The server may have replaced this key before the response was lost.
        newKey = null;
        deliveryStatus = null;
        copied = false;
        copyFailed = false;
      }
    }
    if (changesDevices) void loadDevices();
  } finally { busy = null; render(); }
}

refresh.addEventListener("click", () => {
  if (loading || busy) return;
  if (outcomeUnknown) window.location.reload();
  else void load();
});
document.addEventListener("site:localechange", render);
window.addEventListener("pagehide", () => {
  devicesRequest += 1;
  subscriptionRequest += 1;
  newKey = null;
  keyPanel.replaceChildren();
  keyPanel.hidden = true;
  api?.clear();
});
render();
initSite().then((value) => { context = value; api = createCustomerApi(context.config.apiBaseUrl); return load(); })
  .catch((error) => { coreError = error; loading = false; render(); });
