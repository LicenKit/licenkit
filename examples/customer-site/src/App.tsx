import { useMemo } from "react";
import { ErrorPanel } from "./components/ui";
import { CustomerPortalPage } from "./pages/CustomerPortalPage";
import { ProductCatalogPage } from "./pages/ProductCatalogPage";
import { readSiteConfig } from "./site-config";

function customerAccountSlug(pathname: string): string | null {
  const match = pathname.match(/^\/customer\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/auth)?\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function App() {
  const routeAccountSlug = customerAccountSlug(window.location.pathname);
  const config = useMemo(() => {
    try {
      return { value: readSiteConfig(), error: null };
    } catch (error) {
      return { value: null, error };
    }
  }, []);

  if (routeAccountSlug) return <CustomerPortalPage accountSlug={routeAccountSlug} />;
  if (!config.value) {
    return <main className="centered-page"><section className="connection-error card"><h1>Site 尚未配置</h1><p>填写 Paddle 前端配置，并在 product-catalog.ts 中维护静态产品与方案。</p><ErrorPanel error={config.error} title="配置无效" /></section></main>;
  }
  return <ProductCatalogPage config={config.value} />;
}
