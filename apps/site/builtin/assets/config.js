/** Public Site configuration shared by the browser and the build script. */
export class SiteConfigError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "SiteConfigError";
  }
}

function invalid(path, message) {
  throw new SiteConfigError(path, message);
}

function object(value, path, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${path}.${key}`, "is not a supported public configuration field");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, "is required");
  }
}

function text(value, path, { nonempty = false, max = 4000 } = {}) {
  if (typeof value !== "string") invalid(path, "must be a string");
  if (value.length > max || (nonempty && !value.trim())) invalid(path, `must ${nonempty ? "be nonempty and " : ""}contain at most ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) invalid(path, "contains unsupported control characters");
}

function webUrl(value, path, { relative = false, mailto = false, navigation = false } = {}) {
  text(value, path, { nonempty: true, max: 2048 });
  if (value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value)) invalid(path, "must be a valid URL without whitespace or backslashes");
  if (relative && value.startsWith("/") && !value.startsWith("//")) {
    const parsed = new URL(value, "https://site.invalid");
    if ((!navigation && (parsed.search || parsed.hash)) || /%2f|%5c|%2e/iu.test(value.split(/[?#]/u)[0]) || value.split(/[?#]/u)[0].split("/").some((part) => part === "." || part === "..")) invalid(path, "must be a path without traversal segments or unsupported query/fragment");
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid(path, "must be a valid URL");
  }
  if (mailto && parsed.protocol === "mailto:") {
    if (!/^[^\s@]+@[^\s@]+$/u.test(parsed.pathname) || parsed.hash || /%0[ad]/iu.test(value)) invalid(path, "must be a valid support email link");
    return;
  }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) invalid(path, "must use HTTPS (HTTP is allowed only on localhost or 127.0.0.1)");
  if (parsed.username || parsed.password || (!navigation && (parsed.search || parsed.hash))) invalid(path, "must not contain credentials or unsupported query/fragment");
}

/** Validate the entire selected file, without inserting or merging defaults. */
export function validateSiteConfig(config) {
  object(config, "site", ["name", "description", "supportUrl", "apiBaseUrl", "paddle", "products"]);
  text(config.name, "site.name", { nonempty: true, max: 160 });
  text(config.description, "site.description");
  if (config.supportUrl !== null) webUrl(config.supportUrl, "site.supportUrl", { relative: true, mailto: true, navigation: true });
  webUrl(config.apiBaseUrl, "site.apiBaseUrl", { relative: true });
  if (config.paddle !== null) {
    object(config.paddle, "site.paddle", ["environment", "clientSideToken"]);
    if (!["sandbox", "live"].includes(config.paddle.environment)) invalid("site.paddle.environment", "must be sandbox or live");
    text(config.paddle.clientSideToken, "site.paddle.clientSideToken", { nonempty: true, max: 2048 });
    const prefix = config.paddle.environment === "sandbox" ? "test_" : "live_";
    if (!config.paddle.clientSideToken.startsWith(prefix) || !/^(test|live)_[A-Za-z0-9_-]+$/u.test(config.paddle.clientSideToken)) invalid("site.paddle.clientSideToken", "must be a client-side token matching the selected environment");
  }
  if (!Array.isArray(config.products)) invalid("site.products", "must be an array");
  if (config.products.length && config.paddle === null) invalid("site.paddle", "is required when products are offered for purchase");
  const ids = new Set();
  config.products.forEach((product, index) => {
    const path = `site.products[${index}]`;
    object(product, path, ["id", "name", "description", "plans"]);
    text(product.id, `${path}.id`, { nonempty: true, max: 160 });
    if (ids.has(product.id)) invalid(`${path}.id`, "must be unique");
    ids.add(product.id);
    text(product.name, `${path}.name`, { nonempty: true, max: 160 });
    text(product.description, `${path}.description`);
    if (!Array.isArray(product.plans) || !product.plans.length) invalid(`${path}.plans`, "must contain at least one purchase plan");
    product.plans.forEach((plan, planIndex) => {
      const planPath = `${path}.plans[${planIndex}]`;
      object(plan, planPath, ["name", "description", "price", "priceId"]);
      text(plan.name, `${planPath}.name`, { nonempty: true, max: 160 });
      text(plan.description, `${planPath}.description`);
      text(plan.price, `${planPath}.price`, { nonempty: true, max: 500 });
      if (typeof plan.priceId !== "string" || !/^pri_[A-Za-z0-9]+$/u.test(plan.priceId)) invalid(`${planPath}.priceId`, "must be a Paddle Price ID beginning with pri_");
    });
  });
  return config;
}
