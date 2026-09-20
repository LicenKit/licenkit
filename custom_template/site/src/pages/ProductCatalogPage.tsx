import { useEffect, useRef, useState } from "react";
import { ArrowRight, KeyRound, Loader2, ShoppingBag } from "lucide-react";
import {
  createLicenKitCheckout,
  LicenKitCheckoutError,
  type CheckoutState,
  type LicenKitCheckout,
  type LocalizedPrice,
} from "@licenkit/checkout";
import { Button, Card, ErrorPanel } from "../components/ui";
import type { SiteConfig } from "../site-config";

interface ProductView {
  slug: string;
  checkout: LicenKitCheckout;
  state: CheckoutState | null;
  prices: Map<string, LocalizedPrice>;
  error: unknown;
}

function publicMessage(error: unknown): string {
  if (!(error instanceof LicenKitCheckoutError)) return "产品信息暂时无法加载，请稍后重试。";
  if (error.code === "CHECKOUT_NOT_AVAILABLE") return "当前暂时无法购买。";
  if (error.code === "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE") return "该网站域名尚未启用支付。";
  if (error.code === "CHECKOUT_OFFER_NOT_FOUND") return "该购买方案已经变化，请刷新页面。";
  return "支付暂时不可用，请稍后重试。";
}

export function ProductCatalogPage({ config }: { config: SiteConfig }) {
  const productsRef = useRef<ProductView[]>([]);
  const [products, setProducts] = useState<ProductView[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    const entries = config.productSlugs.map((slug) => {
      const checkout = createLicenKitCheckout({
        licenkitBaseUrl: config.licenkitBaseUrl,
        accountSlug: config.accountSlug,
        productSlug: slug,
      });
      return { slug, checkout, state: null, prices: new Map<string, LocalizedPrice>(), error: null } satisfies ProductView;
    });
    productsRef.current = entries;
    setProducts(entries);
    for (const entry of entries) {
      void (async () => {
        try {
          const state = await entry.checkout.load();
          const prices = state.available
            ? new Map((await entry.checkout.previewPrices()).map((price) => [price.offerId, price]))
            : new Map<string, LocalizedPrice>();
          if (!active) return;
          setProducts((current) => current.map((item) => item.slug === entry.slug ? { ...item, state, prices } : item));
        } catch (error) {
          if (!active) return;
          setProducts((current) => current.map((item) => item.slug === entry.slug ? { ...item, error } : item));
        }
      })();
    }
    return () => {
      active = false;
      for (const entry of entries) entry.checkout.destroy();
      productsRef.current = [];
    };
  }, [config]);

  async function buy(productSlug: string, offerId: string) {
    const product = productsRef.current.find((entry) => entry.slug === productSlug);
    if (!product) return;
    setOpening(`${productSlug}:${offerId}`);
    setCheckoutError(null);
    try {
      await product.checkout.open({ offerId, successUrl: new URL("/purchase-success.html", window.location.origin).href });
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
        <h1>选择适合你的产品</h1>
        <p>价格会根据访客所在地区由支付平台实时返回；只有成功取得价格的方案才能进入购买流程。</p>
      </section>
      <section className="catalog-grid" aria-live="polite">
        {products.map((product) => (
          <Card className="product-card" key={product.slug}>
            {!product.state && !product.error ? <div className="state-panel"><Loader2 className="size-5 animate-spin" />正在加载产品</div> : null}
            {product.error ? <><h2>{product.slug}</h2><p>{publicMessage(product.error)}</p><ErrorPanel error={product.error} title="产品加载失败" /></> : null}
            {product.state ? <>
              <div className="product-heading"><ShoppingBag className="size-5" /><div><h2>{product.state.product.name}</h2>{product.state.product.description ? <p>{product.state.product.description}</p> : null}</div></div>
              {!product.state.available ? <p className="catalog-message">当前暂时无法购买。</p> : null}
              <div className="catalog-offers">{product.state.offers.map((offer) => {
                const price = product.prices.get(offer.id);
                const pending = opening === `${product.slug}:${offer.id}`;
                return <article className="catalog-offer" key={offer.id}>
                  <div><strong>{offer.name}</strong><span>{offer.purchaseType === "one_time" ? "一次性购买" : "订阅"}</span></div>
                  <b>{price?.formattedTotal ?? "价格不可用"}</b>
                  <Button disabled={!price || opening !== null} loading={pending} onClick={() => void buy(product.slug, offer.id)}>购买</Button>
                </article>;
              })}</div>
            </> : null}
          </Card>
        ))}
      </section>
      {checkoutError ? <section className="site-error"><p>{publicMessage(checkoutError)}</p><ErrorPanel error={checkoutError} title="无法打开支付" /></section> : null}
    </main>
  );
}
