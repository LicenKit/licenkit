export interface SitePlan {
  id: string;
  name: string;
  description?: string;
  purchaseType: "one_time" | "subscription";
  priceLabel: string;
  paddlePriceId: string;
}

export interface SiteProduct {
  id: string;
  name: string;
  description?: string;
  plans: readonly SitePlan[];
}

/**
 * 官网产品与方案是静态内容。修改展示文案时直接编辑本文件；
 * paddlePriceId 同时配置在 LicenKit Admin 的 Billing Offer 中，
 * 后端只根据已验签 Paddle Webhook 中的 Price ID 关联 Product 与 License Plan。
 */
export const productCatalog = [
  {
    id: "example-app",
    name: "Example App",
    description: "请替换为你的产品介绍。",
    plans: [
      {
        id: "pro",
        name: "Pro",
        description: "请替换为你的授权方案说明。",
        purchaseType: "one_time",
        priceLabel: "请配置价格",
        paddlePriceId: "pri_REPLACE_ME",
      },
    ],
  },
] satisfies readonly SiteProduct[];
