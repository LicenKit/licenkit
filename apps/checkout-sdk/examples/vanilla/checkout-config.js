export function readCheckoutConfig() {
  const config = Object.freeze({
    licenkitBaseUrl: "https://license.example.com",
    accountSlug: "example-studio",
    productSlug: "example-app",
  });
  if (!config.licenkitBaseUrl || !config.accountSlug || !config.productSlug) {
    throw new Error("The three public LicenKit Checkout selectors must be configured.");
  }
  return config;
}
