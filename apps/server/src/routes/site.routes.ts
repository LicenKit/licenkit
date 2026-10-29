import type { Context } from "hono";
import type { AppContext } from "../types";
import { AppError } from "../middleware/error";
import { isSchemefulSameSite, isTrustedUrlProtocolAllowed } from "../config/trusted-url";

type SiteContext = Context<AppContext>;

const PAGE_FILES: Readonly<Record<string, string>> = {
  "/": "index.html",
  "/pricing": "pricing.html",
  "/purchase-success": "purchase-success.html",
  "/customer": "customer/index.html",
  "/customer/login": "customer/login.html",
  "/customer/auth": "customer/auth.html",
};
const ADMIN_PAGES = new Set([
  "/admin/",
  "/admin/index.html",
  "/admin/forgot-password",
  "/admin/reset-password",
  "/admin/recover-password",
  "/admin/invitations/accept",
]);
const CONFIG_LIMIT_BYTES = 128 * 1024;
const PRIVATE_SEGMENT = /^(?:api|admin|__site)$/i;
const CONTROL_FILE = /^(?:_headers|_redirects|_worker\.js)$/i;

function decodedPath(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!path.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(path) || /%[0-9a-f]{2}/i.test(path)) return null;
  if (path !== "/" && path.includes("//")) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith(".") || CONTROL_FILE.test(segment))) return null;
  return path;
}

function siteFile(path: string): string {
  const pagePath = path === "/" ? path : path.replace(/\/$/, "");
  if (PAGE_FILES[pagePath]) return PAGE_FILES[pagePath];
  if (/^\/customer\/licenses\/[A-Za-z0-9_-]+\/?$/.test(path)) return "customer/license.html";
  if (path.endsWith("/")) return `${path.slice(1)}index.html`;
  const relative = path.slice(1);
  return relative.split("/").at(-1)!.includes(".") ? relative : `${relative}.html`;
}

function assetRequest(c: SiteContext, pathname: string, method = c.req.method, conditional = true): Request {
  const url = new URL(c.req.url);
  url.pathname = pathname;
  url.search = "";
  const headers = new Headers();
  if (conditional) {
    for (const key of ["if-none-match", "if-modified-since", "range", "if-range"]) {
      const value = c.req.header(key);
      if (value) headers.set(key, value);
    }
  }
  return new Request(url, { method, headers });
}

async function readSiteFile(c: SiteContext, file: string, method = c.req.method, conditional = true): Promise<Response> {
  const assets = c.env.ASSETS;
  if (!assets) throw new AppError("SITE_ASSETS_NOT_CONFIGURED", "Site assets are not configured.", 503);
  const custom = await assets.fetch(assetRequest(c, `/__site/custom/${file}`, method, conditional));
  const response = custom.status !== 404
    ? custom
    : await assets.fetch(assetRequest(c, `/__site/builtin/${file}`, method, conditional));
  if (response.status >= 500) {
    console.error("Site asset read failed", {
      code: "SITE_ASSET_READ_FAILED",
      requestId: c.get("requestId"),
      source: custom.status === 404 ? "builtin" : "custom",
      status: response.status,
    });
  }
  return response;
}

async function readApiOrigin(c: SiteContext): Promise<string> {
  const config = await readSiteFile(c, "site.json", "GET", false);
  if (!config.ok || !config.body) {
    throw new AppError("SITE_CONFIGURATION_INVALID", "The Site configuration could not be read.", 500);
  }
  const reader = config.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CONFIG_LIMIT_BYTES) {
      await reader.cancel();
      throw new AppError("SITE_CONFIGURATION_INVALID", "The Site configuration is too large.", 500);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let apiBaseUrl: unknown;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    apiBaseUrl = value && typeof value === "object" && "apiBaseUrl" in value ? value.apiBaseUrl : undefined;
  } catch {
    throw new AppError("SITE_CONFIGURATION_INVALID", "The Site configuration is invalid JSON.", 500);
  }
  if (typeof apiBaseUrl !== "string" || !apiBaseUrl || apiBaseUrl.length > 2048) {
    throw new AppError("SITE_CONFIGURATION_INVALID", "The Site API address is invalid.", 500);
  }
  let api: URL;
  try {
    api = new URL(apiBaseUrl, c.req.url);
  } catch {
    throw new AppError("SITE_CONFIGURATION_INVALID", "The Site API address is invalid.", 500);
  }
  const site = new URL(c.req.url);
  if (api.username || api.password || api.search || api.hash || !isTrustedUrlProtocolAllowed(api, c.env.ENVIRONMENT) || !isSchemefulSameSite(site, api)) {
    throw new AppError("SITE_CONFIGURATION_INVALID", "The Site API address must use the same protocol and primary domain as the Site.", 500);
  }
  return api.origin;
}

function contentSecurityPolicy(file: string, apiOrigin?: string): string {
  const script = ["'self'"];
  const connect = ["'self'", ...(apiOrigin ? [apiOrigin] : [])];
  const frames: string[] = [];
  if (file === "customer/login.html") {
    script.push("https://challenges.cloudflare.com");
    connect.push("https://challenges.cloudflare.com");
    frames.push("https://challenges.cloudflare.com");
  }
  if (file === "pricing.html") {
    script.push("https://cdn.paddle.com");
    connect.push("https://checkout-service.paddle.com", "https://sandbox-checkout-service.paddle.com");
    frames.push("https://buy.paddle.com", "https://sandbox-buy.paddle.com");
  }
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self'",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    `frame-src ${frames.length ? frames.join(" ") : "'none'"}`,
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

async function siteResponse(c: SiteContext, response: Response, file: string, status = response.status): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", file.startsWith("customer/") || status >= 400 ? "no-store" : "no-cache");
  if (file.toLowerCase().endsWith(".html")) {
    const apiOrigin = status < 400 ? await readApiOrigin(c) : undefined;
    headers.set("Content-Security-Policy", contentSecurityPolicy(file, apiOrigin));
  }
  return new Response(c.req.method === "HEAD" ? null : response.body, { status, statusText: status === response.status ? response.statusText : undefined, headers });
}

export async function serveSite(c: SiteContext): Promise<Response> {
  const path = decodedPath(new URL(c.req.url).pathname);
  if (!path || PRIVATE_SEGMENT.test(path.split("/")[1] ?? "")) return c.text("Not Found", 404);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
  const file = siteFile(path);
  const response = await readSiteFile(c, file);
  if (response.status !== 404) return siteResponse(c, response, file);
  if (!file.toLowerCase().endsWith(".html")) return siteResponse(c, new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }), file);
  const notFound = file === "404.html" ? response : await readSiteFile(c, "404.html");
  if (notFound.status === 404) return siteResponse(c, new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }), "404.html");
  if (!notFound.ok) return siteResponse(c, notFound, "404.html");
  return siteResponse(c, notFound, "404.html", 404);
}

export async function serveAdminAssets(c: SiteContext): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
  if (!c.env.ASSETS) return c.text("LicenKit Admin assets are not configured.", 404);
  const path = decodedPath(new URL(c.req.url).pathname);
  if (!path) return c.text("Not Found", 404);
  const target = ADMIN_PAGES.has(path) ? "/admin/index.html" : path;
  return c.env.ASSETS.fetch(assetRequest(c, target));
}
