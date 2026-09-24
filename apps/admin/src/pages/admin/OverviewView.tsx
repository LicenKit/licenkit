import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, CircleDollarSign, KeyRound, Package, RefreshCw, Send } from "lucide-react";
import { api, type AdminStats, type BillingOffer, type EmailDelivery, type InboundEvent, type SystemIssue } from "../../lib/api-client";
import { Badge, Button, Card, EmptyState, ErrorPanel, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useI18n } from "../../lib/i18n";

export function OverviewView() {
  const { t, formatDate } = useI18n();
  const [stats, setStats] = useState<AdminStats | null>(null);
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
      api.admin.stats.get(),
      api.admin.billing.offers.list(),
      api.admin.billing.events.list({ status: "needs_attention,failed", limit: 6 }),
      api.admin.emailDeliveries.list({ status: "failed", limit: 6 }),
      api.admin.system.issues.list({ status: "pending" }),
    ]);
    if (results[0].status === "fulfilled") setStats(results[0].value);
    if (results[1].status === "fulfilled") setOffers(results[1].value.items);
    if (results[2].status === "fulfilled") setEvents(results[2].value.items);
    if (results[3].status === "fulfilled") setDeliveries(results[3].value.items);
    if (results[4].status === "fulfilled") setIssues(results[4].value.items);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason);
    setLoading(false);
  }

  useEffect(() => { void load() }, []);
  const attentionEvents = events;
  const deliveryProblems = deliveries;
  const pendingDeliveriesCount = stats?.pendingDeliveries ?? deliveries.length;
  const pendingEventsCount = stats?.pendingInboundEvents ?? attentionEvents.length;
  const totalAlerts = pendingEventsCount + pendingDeliveriesCount;
  const activeOffers = offers.filter((item) => item.status === "active");

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.overview.eyebrow}
        title={t.overview.title}
        description={t.overview.description}
        action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />{t.common.refresh}</Button>}
      />
      <ErrorPanel error={error} onClose={() => setError(null)} title={t.overview.errorTitle} />
      {loading && !stats ? <LoadingState label={t.overview.loadingLabel} /> : (
        <>
          <section className="metric-grid">
            <Card className="metric-card">
              <Package />
              <span>{t.overview.metricProducts}</span>
              <strong>{stats?.totalProducts ?? 0}</strong>
              <small>{t.overview.metricProductsSub}</small>
            </Card>
            <Card className="metric-card">
              <KeyRound />
              <span>{t.overview.metricLicenses}</span>
              <strong>{stats?.totalLicenses ?? 0}</strong>
              <small>{t.overview.metricLicensesSub(stats?.activeActivations ?? 0)}</small>
            </Card>
            <Card className="metric-card">
              <CircleDollarSign />
              <span>{t.overview.metricOffers}</span>
              <strong>{offers.length}</strong>
              <small>{t.overview.metricOffersSub(activeOffers.length)}</small>
            </Card>
            <Card className={totalAlerts > 0 ? "metric-card metric-alert" : "metric-card"}>
              <AlertTriangle />
              <span>{t.overview.metricTodos}</span>
              <strong>{totalAlerts}</strong>
              <small>{t.overview.metricTodosSub(pendingEventsCount, pendingDeliveriesCount)}</small>
            </Card>
          </section>
          <section className="overview-grid">
            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">{t.overview.pricingEyebrow}</p>
                  <h2>{t.overview.pricingTitle}</h2>
                  <p>{t.overview.pricingDesc}</p>
                </div>
                <CircleDollarSign className="size-5" />
              </div>
              {offers.length === 0 ? (
                <EmptyState title={t.overview.pricingEmptyTitle} description={t.overview.pricingEmptyDesc} />
              ) : (
                <div className="stack-list">
                  {offers.slice(0, 6).map((offer) => (
                    <div className="stack-row" key={offer.id}>
                      <div className="grow">
                        <strong>{offer.productName || offer.productId}</strong>
                        <span>{offer.licensePlanName || offer.licensePlanId} · {offer.purchaseType === "subscription" ? t.overview.typeSubscription : t.overview.typeOneTime}</span>
                      </div>
                      <StatusBadge status={offer.status} label={offer.status === "active" ? t.overview.statusActive : offer.status === "archived" ? t.overview.statusArchived : t.overview.statusDraft} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">{t.overview.todosEyebrow}</p>
                  <h2>{t.overview.todosTitle}</h2>
                  <p>{t.overview.todosDesc}</p>
                </div>
                <Send className="size-5" />
              </div>
              {attentionEvents.length + deliveryProblems.length === 0 ? (
                <div className="healthy-state">
                  <CheckCircle2 className="size-6" />
                  <strong>{t.overview.healthyTitle}</strong>
                  <span>{t.overview.healthyDesc}</span>
                </div>
              ) : (
                <div className="stack-list">
                  {attentionEvents.slice(0, 4).map((event) => (
                    <div className="stack-row" key={event.id}>
                      <AlertTriangle className="size-5 text-warning" />
                      <div className="grow">
                        <strong>{event.eventType}</strong>
                        <span>{event.externalEventId} · {formatDate(event.receivedAt)}</span>
                      </div>
                      <StatusBadge status={event.status} />
                    </div>
                  ))}
                  {deliveryProblems.slice(0, 4).map((delivery) => (
                    <div className="stack-row" key={delivery.id}>
                      <ArrowUpRight className="size-5 text-danger" />
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
                  <p className="eyebrow">{t.overview.recentIssuesEyebrow}</p>
                  {issues.slice(0, 4).map((issue) => (
                    <div className="stack-row" key={issue.id}>
                      <AlertTriangle className="size-5 text-danger" />
                      <div className="grow">
                        <strong>{issue.errorCode}</strong>
                        <span>{issue.category} · {issue.operation} · {formatDate(issue.lastSeenAt)}</span>
                      </div>
                      <StatusBadge status={issue.status} label={issue.status === "pending" ? t.overview.statusPending : t.overview.statusProcessed} />
                      <Badge tone="warning">{t.overview.occurrenceTimes(issue.occurrenceCount)}</Badge>
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
