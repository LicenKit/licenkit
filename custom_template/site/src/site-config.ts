export interface SiteConfig {
  accountSlug: string;
  productSlugs: string[];
  licenkitBaseUrl: string;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requiredSlug(value: string | undefined, name: string): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!SLUG_PATTERN.test(normalized) || normalized.length > 100) {
    throw new Error(`${name} 必须是合法的 URL slug。请检查 site/.env 中的配置。`);
  }
  return normalized;
}

export function readSiteConfig(): SiteConfig {
  const accountSlug = requiredSlug(import.meta.env.VITE_LICENKIT_ACCOUNT_SLUG, "VITE_LICENKIT_ACCOUNT_SLUG");
  const productSlugs = [...new Set(
    String(import.meta.env.VITE_LICENKIT_PRODUCT_SLUGS ?? "")
      .split(",")
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean)
      .map((slug) => requiredSlug(slug, "VITE_LICENKIT_PRODUCT_SLUGS")),
  )];
  if (productSlugs.length === 0) {
    throw new Error("VITE_LICENKIT_PRODUCT_SLUGS 至少需要一个产品 slug。多个产品使用英文逗号分隔。");
  }
  const configuredBaseUrl = String(import.meta.env.VITE_LICENKIT_BASE_URL ?? "").trim();
  return {
    accountSlug,
    productSlugs,
    licenkitBaseUrl: configuredBaseUrl || window.location.origin,
  };
}
