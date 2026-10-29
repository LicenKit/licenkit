import { initSite, getLocale, pageTitle } from "./site.js";
import { text } from "./i18n.js";
import { el, showError, clearError } from "./ui.js";
import { openCheckout } from "./checkout.js";

let context;
let checkoutBusy = false;
let pageError;
const errorTarget = document.querySelector("[data-page-error]");

function emptyProducts() {
  return el("div", { className: "empty-state" }, el("span", { className: "empty-symbol", "aria-hidden": "true", text: "+" }), el("h3", { text: text("noProductsTitle", context.locale) }), el("p", { className: "muted", text: text("noProductsBody", context.locale) }), el("a", { className: "button button-secondary", href: "/customer/", text: text("openLicenses", context.locale) }));
}

function productPreview(product) {
  return el("article", { className: "card product-card" }, el("div", { className: "product-symbol", "aria-hidden": "true", text: product.name.slice(0, 1) }), el("h3", { text: product.name }), el("p", { className: "muted", text: product.description }), el("a", { className: "text-link", href: `/pricing#${encodeURIComponent(product.id)}`, text: text("planDetails", context.locale) }));
}

function purchasePlan(plan) {
  const button = el("button", { type: "button", className: "button", text: text("buyNow", context.locale), disabled: checkoutBusy });
  button.addEventListener("click", async () => {
    if (checkoutBusy) return;
    checkoutBusy = true;
    pageError = undefined;
    clearError(errorTarget);
    document.querySelectorAll("[data-checkout-button]").forEach((item) => { item.disabled = true; });
    button.textContent = text("openingCheckout", context.locale);
    try { await openCheckout(context.config, plan.priceId, context.locale); }
    catch (caught) {
      pageError = caught;
      showError(errorTarget, caught, context.locale);
      errorTarget.scrollIntoView({ block: "nearest" });
    }
    finally {
      checkoutBusy = false;
      render();
    }
  });
  button.setAttribute("data-checkout-button", "");
  return el("article", { className: "card plan-card" }, el("h3", { text: plan.name }), el("p", { className: "muted", text: plan.description }), el("p", { className: "plan-price", text: plan.price }), button);
}

function render() {
  const page = document.body.dataset.page;
  const title = { home: "homeTitle", pricing: "pricingTitle", result: "resultTitle", notfound: "notFoundTitle" }[page];
  pageTitle(title, context);
  if (pageError) showError(errorTarget, pageError, context.locale);
  // Keep the active operation's DOM stable while the payment script is loading.
  if (checkoutBusy) return;
  const products = document.querySelector("[data-products]");
  if (products) {
    if (!context.config.products.length) products.replaceChildren(emptyProducts());
    else if (page === "home") products.replaceChildren(...context.config.products.map(productPreview));
    else products.replaceChildren(...context.config.products.map((product) => el("section", { className: "product-plans", id: product.id }, el("div", { className: "section-heading" }, el("h2", { text: product.name }), el("p", { className: "muted", text: product.description })), el("div", { className: "plan-grid" }, ...product.plans.map(purchasePlan)))));
  }
}

document.addEventListener("site:localechange", () => {
  if (context) render();
  else if (pageError) showError(errorTarget, pageError, getLocale());
});

try { context = await initSite(); render(); }
catch (error) { pageError = error; showError(errorTarget, error, getLocale()); }
