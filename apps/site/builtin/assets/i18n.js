const messages = {
  "en-US": {
    navPricing: "Products & pricing", navLicenses: "My licenses", support: "Contact support", languageLabel: "Language", skipContent: "Skip to content",
    homeTitle: "Products and licenses, in one place.", homeIntro: "Explore our products, find the right plan, and keep your purchased licenses close at hand.",
    viewPricing: "Explore products", existingCustomer: "Already purchased?", existingIntro: "Use the email address from your purchase to find your licenses, manage devices, and view subscriptions.", openLicenses: "View my licenses",
    productsHeading: "Our products", productsIntro: "Choose a product to see its available plans.", noProductsTitle: "No products are listed yet", noProductsBody: "Already own a license? You can still sign in to manage it.",
    pricingTitle: "Find the right plan.", pricingIntro: "Explore the available products and plans. Your purchase is handled securely by Paddle.", buyNow: "Buy this plan", openingCheckout: "Opening checkout…", planDetails: "View plans", purchaseHint: "After purchase, check your email for your license and sign-in instructions.",
    resultTitle: "Your next step: check your email.", resultIntro: "If you completed payment, your license will appear after the purchase has been processed. You can check your email or sign in with the address used for your purchase.", resultNote: "Opening this page does not confirm payment or license delivery.", resultHelp: "Need help with a purchase?", resultHelpBody: "If your license has not appeared, contact support with the email address used for your purchase.",
    notFoundTitle: "This page could not be found.", notFoundIntro: "The address may have changed, or the page may no longer be available.", returnHome: "Return to home", errorTitle: "This part of the page could not be loaded.", errorBody: "Please try again. If the problem continues, contact support.", errorDetails: "View error details", copyright: "Products, purchases, and your licenses.",
  },
  "zh-CN": {
    navPricing: "产品与价格", navLicenses: "我的授权", support: "联系支持", languageLabel: "语言", skipContent: "跳到主要内容",
    homeTitle: "选购产品，管理授权。", homeIntro: "了解我们的产品，选择适合的方案，也可以随时查看和管理已经购买的授权。",
    viewPricing: "查看产品", existingCustomer: "已经购买？", existingIntro: "使用购买时的邮箱登录，即可查看授权、管理设备和了解订阅情况。", openLicenses: "查看我的授权",
    productsHeading: "产品一览", productsIntro: "选择产品，查看可购买的方案。", noProductsTitle: "暂无在售产品", noProductsBody: "已经拥有授权？你仍然可以登录并管理。",
    pricingTitle: "选择适合你的方案。", pricingIntro: "查看产品和可购买的方案，付款由 Paddle 安全处理。", buyNow: "购买此方案", openingCheckout: "正在打开付款窗口…", planDetails: "查看方案", purchaseHint: "购买后，请查看邮件中的注册码和登录说明。",
    resultTitle: "接下来，请查看你的邮箱。", resultIntro: "如果你已完成付款，系统会在购买处理完成后发放授权。你可以查看邮件，或使用购买时的邮箱登录查询。", resultNote: "打开此页面不代表付款成功或授权已经送达。", resultHelp: "购买遇到问题？", resultHelpBody: "如果授权尚未出现，请使用购买时的邮箱联系支持。",
    notFoundTitle: "找不到这个页面。", notFoundIntro: "地址可能已变更，或页面已经不存在。", returnHome: "返回首页", errorTitle: "这部分内容暂时无法加载。", errorBody: "请重试。如果问题持续，请联系支持。", errorDetails: "查看错误信息", copyright: "了解产品，完成购买，管理授权。",
  },
};

export function text(key, locale = "en-US", params = {}) {
  const dictionary = messages[locale];
  if (!dictionary || !Object.hasOwn(dictionary, key)) throw new Error(`SITE_TRANSLATION_MISSING: ${locale}.${key}`);
  return dictionary[key].replace(/\{(\w+)\}/gu, (_, name) => String(params[name] ?? `{${name}}`));
}

export function translateDocument(locale, root = document) {
  root.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = text(element.dataset.i18n, locale); });
}
