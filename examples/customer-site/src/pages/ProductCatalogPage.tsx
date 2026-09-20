import { useState } from "react";
import { ArrowRight, KeyRound, ShoppingBag } from "lucide-react";
import { Button, Card, ErrorPanel } from "../components/ui";
import { openPaddleCheckout, PaddleCheckoutError } from "../lib/paddle-checkout";
import type { SitePlan } from "../product-catalog";
import type { SiteConfig } from "../site-config";

function publicMessage(error: unknown): string {
  if (!(error instanceof PaddleCheckoutError)) return "支付暂时不可用，请稍后重试。";
  if (error.code === "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE") return "该网站域名尚未启用支付。";
  if (error.code === "PADDLE_CONFIG_INVALID") return "产品页支付配置无效，请联系网站管理员。";
  return "支付暂时不可用，请稍后重试。";
}

export function ProductCatalogPage({ config }: { config: SiteConfig }) {
  const [opening, setOpening] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<unknown>(null);

  async function buy(productId: string, plan: SitePlan) {
    const selection = `${productId}:${plan.id}`;
    setOpening(selection);
    setCheckoutError(null);
    try {
      await openPaddleCheckout({
        environment: config.paddleEnvironment,
        clientSideToken: config.paddleClientSideToken,
        priceId: plan.paddlePriceId,
        successUrl: new URL("/purchase-success.html", window.location.origin).href,
      });
    } catch (error) {
      setCheckoutError(error);
    } finally {
      setOpening(null);
    }
  }

  return (
    <main className="site-shell">
      <header className="site-topbar">
        <a className="brand-inline" href="/"><span className="brand-mark small"><KeyRound className="size-4" /></span><strong>{config.accountSlug}</strong></a>
        <a className="button button-secondary" href={`/customer/${encodeURIComponent(config.accountSlug)}`}>管理 License 与设备 <ArrowRight className="size-4" /></a>
      </header>
      <section className="site-hero">
        <p className="eyebrow">Products</p>
        <h1>选择适合你的授权</h1>
        <p>产品与方案由官网静态维护；付款由 Paddle 托管，授权在服务端确认支付后发放。</p>
      </section>
      <section className="catalog-grid">
        {config.products.map((product) => (
          <Card className="product-card" key={product.id}>
            <div className="product-heading"><ShoppingBag className="size-5" /><div><h2>{product.name}</h2>{product.description ? <p>{product.description}</p> : null}</div></div>
            <div className="catalog-offers">{product.plans.map((plan) => {
              const pending = opening === `${product.id}:${plan.id}`;
              return <article className="catalog-offer" key={plan.id}>
                <div><strong>{plan.name}</strong><span>{plan.description || (plan.purchaseType === "one_time" ? "一次性购买" : "订阅")}</span></div>
                <b>{plan.priceLabel}</b>
                <Button disabled={opening !== null} loading={pending} onClick={() => void buy(product.id, plan)}>购买</Button>
              </article>;
            })}</div>
          </Card>
        ))}
      </section>
      {checkoutError ? <section className="site-error"><p>{publicMessage(checkoutError)}</p><ErrorPanel error={checkoutError} title="无法打开支付" /></section> : null}
    </main>
  );
}
