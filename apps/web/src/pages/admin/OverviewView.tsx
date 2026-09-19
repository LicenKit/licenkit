import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, CircleDollarSign, KeyRound, Package, RefreshCw, Send } from "lucide-react";
import { api, type BillingOffer, type InboundEvent, type License, type OutboundDelivery, type Product } from "../../lib/api-client";
import { Button, Card, EmptyState, ErrorPanel, LoadingState, PageHeader, StatusBadge, formatDate } from "../../components/ui";

export function OverviewView() {
  const [products, setProducts] = useState<Product[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [offers, setOffers] = useState<BillingOffer[]>([]);
  const [events, setEvents] = useState<InboundEvent[]>([]);
  const [deliveries, setDeliveries] = useState<OutboundDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const results = await Promise.allSettled([
      api.admin.products.list(),
      api.admin.licenses.list({ limit: 50 }),
      api.admin.billing.offers.list(),
      api.admin.billing.events.list(),
      api.admin.outbound.deliveries.list(),
    ]);
    if (results[0].status === "fulfilled") setProducts(results[0].value.items);
    if (results[1].status === "fulfilled") setLicenses(results[1].value.items);
    if (results[2].status === "fulfilled") setOffers(results[2].value.items);
    if (results[3].status === "fulfilled") setEvents(results[3].value.items);
    if (results[4].status === "fulfilled") setDeliveries(results[4].value.items);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason);
    setLoading(false);
  }

  useEffect(() => { void load() }, []);
  const attentionEvents = events.filter((item) => item.status === "needs_attention" || item.status === "failed");
  const deliveryProblems = deliveries.filter((item) => ["failed", "blocked_configuration", "payload_expired"].includes(item.status));
  const activeOffers = offers.filter((item) => item.status === "active");
  const checkoutReady = activeOffers.filter((item) => item.readiness?.checkoutAvailable === true);

  return (
    <div className="page-stack">
      <PageHeader eyebrow="运行事实" title="控制台总览" description="这里显示服务端返回的授权、收款、入站事件与通知状态，不从前端推断业务成功。" action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>} />
      <ErrorPanel error={error} title="部分总览数据加载失败" />
      {loading && products.length === 0 ? <LoadingState label="正在读取运行状态" /> : (
        <>
          <section className="metric-grid">
            <Card className="metric-card"><Package /><span>Product</span><strong>{products.length}</strong><small>{products.filter((item) => item.status === "active").length} active</small></Card>
            <Card className="metric-card"><KeyRound /><span>License</span><strong>{licenses.length}</strong><small>{licenses.filter((item) => item.status === "active").length} active</small></Card>
            <Card className="metric-card"><CircleDollarSign /><span>收款可用 Offer</span><strong>{checkoutReady.length}/{activeOffers.length}</strong><small>仅统计服务端 readiness</small></Card>
            <Card className={attentionEvents.length + deliveryProblems.length ? "metric-card metric-alert" : "metric-card"}><AlertTriangle /><span>待处理</span><strong>{attentionEvents.length + deliveryProblems.length}</strong><small>事件 {attentionEvents.length} · 投递 {deliveryProblems.length}</small></Card>
          </section>
          <section className="overview-grid">
            <Card>
              <div className="card-header"><div><p className="eyebrow">Billing</p><h2>Offer 收款状态</h2><p>active 不等于可收款；以实时 readiness 为准。</p></div><CircleDollarSign className="size-5" /></div>
              {offers.length === 0 ? <EmptyState title="还没有 Offer" description="先配置 Product、授权方案和 Paddle Provider。" /> : <div className="stack-list">{offers.slice(0, 6).map((offer) => <div className="stack-row" key={offer.id}><div className="grow"><strong>{offer.productName || offer.productId}</strong><span>{offer.licensePlanName || offer.licensePlanId} · {offer.purchaseType}</span></div><StatusBadge status={offer.status} /><StatusBadge status={offer.readiness?.checkoutAvailable ? "ready" : "not_ready"} /></div>)}</div>}
            </Card>
            <Card>
              <div className="card-header"><div><p className="eyebrow">Operations</p><h2>最近待处理项</h2><p>错误按 Inbound Event 与 Delivery 分开保留。</p></div><Send className="size-5" /></div>
              {attentionEvents.length + deliveryProblems.length === 0 ? <div className="healthy-state"><CheckCircle2 className="size-6" /><strong>当前没有待处理项</strong><span>这不替代外部服务的独立健康检查。</span></div> : (
                <div className="stack-list">
                  {attentionEvents.slice(0, 4).map((event) => <div className="stack-row" key={event.id}><AlertTriangle className="size-5 text-amber-400" /><div className="grow"><strong>{event.eventType}</strong><span>{event.externalEventId} · {formatDate(event.receivedAt)}</span></div><StatusBadge status={event.status} /></div>)}
                  {deliveryProblems.slice(0, 4).map((delivery) => <div className="stack-row" key={delivery.id}><ArrowUpRight className="size-5 text-rose-400" /><div className="grow"><strong>{delivery.type}</strong><span>{delivery.id} · {formatDate(delivery.createdAt)}</span></div><StatusBadge status={delivery.status} /></div>)}
                </div>
              )}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
