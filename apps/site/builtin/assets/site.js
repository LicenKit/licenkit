import { validateSiteConfig } from "./config.js";
import { text, translateDocument } from "./i18n.js";

const LOCALE_KEY = "licenkit.site.locale";
let currentLocale;
let initialization;
let siteConfig;

function detectLocale() {
  return (navigator.languages?.[0] ?? navigator.language ?? "en").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getLocale() {
  if (currentLocale) return currentLocale;
  let stored;
  try { stored = localStorage.getItem(LOCALE_KEY); }
  catch { /* Saving a language preference is optional; browsing still works. */ }
  currentLocale = ["zh-CN", "en-US"].includes(stored) ? stored : detectLocale();
  return currentLocale;
}

function applyLocale(locale) {
  currentLocale = locale;
  document.documentElement.lang = locale;
  translateDocument(locale);
  if (siteConfig?.description) document.querySelectorAll("[data-site-description]").forEach((element) => { element.textContent = siteConfig.description; });
  document.querySelectorAll("[data-locale-select]").forEach((select) => { select.value = locale; });
  document.querySelectorAll("[data-site-navigation]").forEach((nav) => { nav.setAttribute("aria-label", locale === "zh-CN" ? "主导航" : "Main navigation"); });
}

/** Initialize branding and language without reloading sensitive in-memory results. */
export function initSite() {
  if (!initialization) initialization = initializeSite();
  return initialization;
}

async function initializeSite() {
  applyLocale(getLocale());
  document.querySelectorAll("[data-locale-select]").forEach((select) => {
    select.addEventListener("change", () => {
      if (!["zh-CN", "en-US"].includes(select.value)) return;
      applyLocale(select.value);
      try { localStorage.setItem(LOCALE_KEY, currentLocale); }
      catch { /* Optional preference storage must not discard a login token or license key. */ }
      document.dispatchEvent(new CustomEvent("site:localechange", { detail: { locale: currentLocale } }));
    });
  });
  const response = await fetch("/site.json", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`SITE_CONFIG_FETCH_FAILED: HTTP ${response.status}`);
  const config = validateSiteConfig(await response.json());
  siteConfig = config;
  document.querySelectorAll("[data-site-name]").forEach((element) => { element.textContent = config.name; });
  document.querySelectorAll("[data-site-description]").forEach((element) => {
    if (config.description) element.textContent = config.description;
  });
  document.querySelectorAll("[data-support-link]").forEach((link) => {
    link.hidden = !config.supportUrl;
    if (config.supportUrl) link.setAttribute("href", config.supportUrl);
  });
  const page = document.body.dataset.page;
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const active = link.dataset.nav === page || (link.dataset.nav === "customer" && location.pathname.startsWith("/customer"));
    if (active) link.setAttribute("aria-current", "page");
  });
  return { config, get locale() { return currentLocale; } };
}

export function pageTitle(key, context) {
  document.title = `${text(key, context.locale)} · ${context.config.name}`;
}
