export interface ExampleCheckoutConfig {
  licenkitBaseUrl: string;
  accountSlug: string;
  productSlug: string;
}

export function readCheckoutConfig(): ExampleCheckoutConfig {
  const config = {
    licenkitBaseUrl: import.meta.env.VITE_LICENKIT_BASE_URL,
    accountSlug: import.meta.env.VITE_LICENKIT_ACCOUNT_SLUG,
    productSlug: import.meta.env.VITE_LICENKIT_PRODUCT_SLUG,
  };

  if (!config.licenkitBaseUrl || !config.accountSlug || !config.productSlug) {
    throw new Error("The three public LicenKit Checkout selectors must be configured.");
  }
  return config;
}
