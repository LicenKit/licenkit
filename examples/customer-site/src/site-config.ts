import { productCatalog, type SiteProduct } from "./product-catalog";

export type PaddleEnvironment = "sandbox" | "live";

export interface SiteConfig {
  accountSlug: string;
  paddleEnvironment: PaddleEnvironment;
  paddleClientSideToken: string;
  products: readonly SiteProduct[];
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRICE_ID_PATTERN = /^pri_[A-Za-z0-9]+$/;

function requiredSlug(value: string | undefined, name: string): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!SLUG_PATTERN.test(normalized) || normalized.length > 100) {
    throw new Error(`${name} 必须是合法的 URL slug。请检查 site/.env 中的配置。`);
  }
  return normalized;
}

function readPaddleEnvironment(value: string | undefined): PaddleEnvironment {
  if (value === "sandbox" || value === "live") return value;
  throw new Error("VITE_PADDLE_ENVIRONMENT 必须是 sandbox 或 live。");
}

function validateCatalog(products: readonly SiteProduct[]): void {
  if (products.length === 0) throw new Error("product-catalog.ts 至少需要一个产品。");
  const productIds = new Set<string>();
  const priceIds = new Set<string>();
  for (const product of products) {
    if (!SLUG_PATTERN.test(product.id) || productIds.has(product.id)) {
      throw new Error(`产品 ID 无效或重复：${product.id}`);
    }
    productIds.add(product.id);
    if (!product.name.trim() || product.plans.length === 0) {
      throw new Error(`产品 ${product.id} 必须包含名称和至少一个购买方案。`);
    }
    const planIds = new Set<string>();
    for (const plan of product.plans) {
      if (!SLUG_PATTERN.test(plan.id) || planIds.has(plan.id)) {
        throw new Error(`产品 ${product.id} 的方案 ID 无效或重复：${plan.id}`);
      }
      if (!PRICE_ID_PATTERN.test(plan.paddlePriceId) || /replace/i.test(plan.paddlePriceId)) {
        throw new Error(`请在 product-catalog.ts 中为 ${product.id}/${plan.id} 配置真实 Paddle Price ID。`);
      }
      if (priceIds.has(plan.paddlePriceId)) {
        throw new Error(`Paddle Price ID 不能绑定多个静态方案：${plan.paddlePriceId}`);
      }
      planIds.add(plan.id);
      priceIds.add(plan.paddlePriceId);
    }
  }
}

export function readSiteConfig(): SiteConfig {
  const accountSlug = requiredSlug(import.meta.env.VITE_LICENKIT_ACCOUNT_SLUG, "VITE_LICENKIT_ACCOUNT_SLUG");
  const paddleEnvironment = readPaddleEnvironment(import.meta.env.VITE_PADDLE_ENVIRONMENT);
  const paddleClientSideToken = String(import.meta.env.VITE_PADDLE_CLIENT_SIDE_TOKEN ?? "").trim();
  const expectedPrefix = paddleEnvironment === "sandbox" ? "test_" : "live_";
  if (!paddleClientSideToken.startsWith(expectedPrefix) || paddleClientSideToken.length > 512) {
    throw new Error(`VITE_PADDLE_CLIENT_SIDE_TOKEN 必须与 ${paddleEnvironment} 环境匹配。`);
  }
  validateCatalog(productCatalog);
  return { accountSlug, paddleEnvironment, paddleClientSideToken, products: productCatalog };
}
