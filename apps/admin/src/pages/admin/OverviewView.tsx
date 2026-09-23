import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, CircleDollarSign, KeyRound, Package, RefreshCw, Send } from "lucide-react";
import { api, type BillingOffer, type EmailDelivery, type InboundEvent, type License, type Product, type SystemIssue } from "../../lib/api-client";
import { Badge, Button, Card, EmptyState, ErrorPanel, LoadingState, PageHeader, StatusBadge, formatDate } from "../../components/ui";

export function OverviewView() {
  const [products, setProducts] = useState<Product[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [offers, setOffers] = useState<BillingOffer[]>([]);
  const [events, setEvents] = useState<InboundEvent[]>([]);
  const [deliveries, setDeliveries] = useState<EmailDelivery[]>([]);
  const [issues, setIssues] = useState<SystemIssue[]>([]);
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
      api.admin.emailDeliveries.list(),
      api.admin.system.issues.list(),
    ]);
    if (results[0].status === "fulfilled") setProducts(results[0].value.items);
    if (results[1].status === "fulfilled") setLicenses(results[1].value.items);
    if (results[2].status === "fulfilled") setOffers(results[2].value.items);
    if (results[3].status === "fulfilled") setEvents(results[3].value.items);
    if (results[4].status === "fulfilled") setDeliveries(results[4].value.items);
    if (results[5].status === "fulfilled") setIssues(results[5].value.items);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason);
    setLoading(false);
  }

  useEffect(() => { void load() }, []);
  const attentionEvents = events.filter((item) => item.status === "needs_attention" || item.status === "failed");
  const deliveryProblems = deliveries.filter((item) => ["failed", "waiting_configuration", "expired"].includes(item.status));
  const activeOffers = offers.filter((item) => item.status === "active");
  const checkoutReady = activeOffers.filter((item) => item.readiness?.checkoutAvailable === true);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="系统总览"
        title="控制台运行总览"
        description="实时汇总当前实例的受控产品、有效授权、收款就绪度、待办异常与通知投递状态。"
        action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>}
      />
      <ErrorPanel error={error} title="部分总览数据加载失败" />
      {loading && products.length === 0 ? <LoadingState label="正在读取运行状态" /> : (
        <>
          <section className="metric-grid">
            <Card className="metric-card">
              <Package />
              <span>受控产品</span>
              <strong>{products.length}</strong>
              <small>{products.filter((item) => item.status === "active").length} 个已启用</small>
            </Card>
            <Card className="metric-card">
              <KeyRound />
              <span>已签发授权</span>
              <strong>{licenses.length}</strong>
              <small>{licenses.filter((item) => item.status === "active").length} 个生效中</small>
            </Card>
            <Card className="metric-card">
              <CircleDollarSign />
              <span>收款就绪定价</span>
              <strong>{checkoutReady.length}/{activeOffers.length}</strong>
              <small>已通过通道可用性验证</small>
            </Card>
            <Card className={attentionEvents.length + deliveryProblems.length ? "metric-card metric-alert" : "metric-card"}>
              <AlertTriangle />
              <span>待处理待办</span>
              <strong>{attentionEvents.length + deliveryProblems.length}</strong>
              <small>异常事件 {attentionEvents.length} · 失败邮件 {deliveryProblems.length}</small>
            </Card>
          </section>
          <section className="overview-grid">
            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">定价与收款</p>
                  <h2>定价收款就绪状态</h2>
                  <p>实时核对 Paddle 价格映射与在线结账就绪状态。</p>
                </div>
                <CircleDollarSign className="size-5" />
              </div>
              {offers.length === 0 ? (
                <EmptyState title="暂无定价映射" description="请先在产品、授权方案中进行配置，并绑定 Paddle 价格。" />
              ) : (
                <div className="stack-list">
                  {offers.slice(0, 6).map((offer) => (
                    <div className="stack-row" key={offer.id}>
                      <div className="grow">
                        <strong>{offer.productName || offer.productId}</strong>
                        <span>{offer.licensePlanName || offer.licensePlanId} · {offer.purchaseType === "subscription" ? "订阅制" : "买断制"}</span>
                      </div>
                      <StatusBadge status={offer.status} label={offer.status === "active" ? "已激活" : "草稿"} />
                      <StatusBadge status={offer.readiness?.checkoutAvailable ? "ready" : "not_ready"} label={offer.readiness?.checkoutAvailable ? "收款就绪" : "未就绪"} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">运维待办</p>
                  <h2>待处理事项与异常</h2>
                  <p>汇集需要管理员关注的 Webhook 处理异常与邮件发送故障。</p>
                </div>
                <Send className="size-5" />
              </div>
              {attentionEvents.length + deliveryProblems.length === 0 ? (
                <div className="healthy-state">
                  <CheckCircle2 className="size-6" />
                  <strong>当前没有待处理待办</strong>
                  <span>所有入站事件已正常履约，邮件发送与系统运行畅通。</span>
                </div>
              ) : (
                <div className="stack-list">
                  {attentionEvents.slice(0, 4).map((event) => (
                    <div className="stack-row" key={event.id}>
                      <AlertTriangle className="size-5 text-amber-400" />
                      <div className="grow">
                        <strong>{event.eventType}</strong>
                        <span>{event.externalEventId} · {formatDate(event.receivedAt)}</span>
                      </div>
                      <StatusBadge status={event.status} />
                    </div>
                  ))}
                  {deliveryProblems.slice(0, 4).map((delivery) => (
                    <div className="stack-row" key={delivery.id}>
                      <ArrowUpRight className="size-5 text-rose-400" />
                      <div className="grow">
                        <strong>{delivery.notificationType}</strong>
                        <span>{delivery.id} · {formatDate(delivery.createdAt)}</span>
                      </div>
                      <StatusBadge status={delivery.status} />
                    </div>
                  ))}
                </div>
              )}
              {issues.length > 0 ? (
                <div className="stack-list">
                  <p className="eyebrow">最近系统异常</p>
                  {issues.slice(0, 4).map((issue) => (
                    <div className="stack-row" key={issue.id}>
                      <AlertTriangle className="size-5 text-rose-400" />
                      <div className="grow">
                        <strong>{issue.errorCode}</strong>
                        <span>{issue.category} · {issue.operation} · {formatDate(issue.lastSeenAt)}</span>
                      </div>
                      <StatusBadge status={issue.status} label={issue.status === "pending" ? "待处理" : "已处理"} />
                      <Badge tone="warning">{issue.occurrenceCount} 次</Badge>
                    </div>
                  ))}
                </div>
              ) : null}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
