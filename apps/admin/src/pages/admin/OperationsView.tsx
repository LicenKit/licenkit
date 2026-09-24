import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, RotateCw } from "lucide-react";
import { api, type InboundEvent, type SystemIssue } from "../../lib/api-client";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  ErrorPanel,
  LoadingState,
  Modal,
  PageHeader,
  StatusBadge,
  safeJson,
} from "../../components/ui";
import { useI18n } from "../../lib/i18n/I18nContext";

type Tab = "issues" | "events";

export function OperationsView({ canManage, onIssuesChanged }: { canManage: boolean; onIssuesChanged?: () => void }) {
  const { t, formatDate } = useI18n();
  const [tab, setTab] = useState<Tab>("issues");
  const [issues, setIssues] = useState<SystemIssue[]>([]);
  const [events, setEvents] = useState<InboundEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<InboundEvent | null>(null);
  const [replayConfirmTarget, setReplayConfirmTarget] = useState<InboundEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const results = await Promise.allSettled([
      api.admin.system.issues.list(),
      api.admin.billing.events.list(),
    ]);
    if (results[0].status === "fulfilled") setIssues(results[0].value.items);
    if (results[1].status === "fulfilled") setEvents(results[1].value.items);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason);
    setLoading(false);
  }

  useEffect(() => { void load() }, []);

  async function openEvent(item: InboundEvent) {
    setError(null);
    try { setSelectedEvent(await api.admin.billing.events.get(item.id)) } catch (caught) { setError(caught) }
  }

  async function handleConfirmReplay() {
    if (!replayConfirmTarget) return;
    setSaving(true);
    setError(null);
    try {
      const replayed = await api.admin.billing.events.replay(replayConfirmTarget.id);
      setSelectedEvent(replayed);
      setReplayConfirmTarget(null);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function processIssue(item: SystemIssue) {
    setSaving(true);
    setError(null);
    try {
      await api.admin.system.issues.process(item.id);
      await load();
      onIssuesChanged?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.operations.eyebrow}
        title={t.operations.title}
        description={t.operations.description}
        action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />{t.common.refresh}</Button>}
      />
      <ErrorPanel error={error} onClose={() => setError(null)} />
      <div className="tabs">
        {(["issues", "events"] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item === "issues" ? t.operations.tabIssues : t.operations.tabEvents}
          </button>
        ))}
      </div>
      {loading && issues.length + events.length === 0 ? <LoadingState /> : null}

      {tab === "issues" ? (
        <Card>
          <div className="card-header">
            <div>
              <p className="eyebrow">{t.operations.issuesEyebrow}</p>
              <h2>{t.operations.issuesTitle}</h2>
              <p>{t.operations.issuesDesc}</p>
            </div>
            <Badge tone={issues.some((item) => item.status === "pending") ? "warning" : "neutral"}>
              {t.operations.issuesPendingCount(issues.filter((item) => item.status === "pending").length)}
            </Badge>
          </div>
          {issues.length === 0 ? (
            <EmptyState title={t.operations.issuesEmptyTitle} description={t.operations.issuesEmptyDesc} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t.operations.tableColCategory}</th>
                    <th>{t.operations.tableColErrorCode}</th>
                    <th>{t.operations.tableColStatus}</th>
                    <th>{t.operations.tableColSource}</th>
                    <th>{t.operations.tableColOccurrences}</th>
                    <th>{t.operations.tableColLastTime}</th>
                    <th>{t.operations.tableColActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((item) => (
                    <tr key={item.id}>
                      <td><Badge tone="warning">{item.category}</Badge></td>
                      <td><strong>{item.errorCode}</strong><small>{item.operation}</small></td>
                      <td><StatusBadge status={item.status} label={item.status === "pending" ? t.operations.statusPending : t.operations.statusProcessed} /></td>
                      <td>{item.sourceType}<small>{item.sourceId}</small></td>
                      <td>{t.operations.countOccurrences(item.occurrenceCount)}</td>
                      <td>{formatDate(item.lastSeenAt)}<small>{t.operations.firstSeenTime(formatDate(item.firstSeenAt))}</small></td>
                      <td>
                        <div className="button-row wrap">
                          {canManage && item.status === "pending" ? (
                            <Button variant="secondary" loading={saving} onClick={() => void processIssue(item)}>
                              <CheckCircle2 className="size-4" />{t.operations.btnMarkProcessed}
                            </Button>
                          ) : null}
                          <details>
                            <summary>{t.operations.btnDiagnostics}</summary>
                            <pre>{safeJson(item.error)}</pre>
                          </details>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "events" ? (
        <Card>
          <div className="card-header">
            <div>
              <p className="eyebrow">{t.operations.eventsCardEyebrow}</p>
              <h2>{t.operations.eventsTitle}</h2>
              <p>{t.operations.eventsDesc}</p>
            </div>
            <Badge>{t.operations.totalEventsCount(events.length)}</Badge>
          </div>
          {events.length === 0 ? (
            <EmptyState title={t.operations.eventsEmptyTitle} description={t.operations.eventsEmptyDesc} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t.operations.tableColEventType}</th>
                    <th>{t.operations.tableColExternalId}</th>
                    <th>{t.operations.tableColProviderEnv}</th>
                    <th>{t.operations.tableColStatus}</th>
                    <th>{t.operations.tableColError}</th>
                    <th>{t.operations.tableColActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.eventType}</strong><small>{formatDate(item.receivedAt)}</small></td>
                      <td><code>{item.externalEventId}</code><small>{item.externalTransactionId || item.externalSubscriptionId || item.externalCustomerId || "—"}</small></td>
                      <td>{item.provider} · {item.environment}</td>
                      <td><StatusBadge status={item.status} /></td>
                      <td>{item.lastError?.code || item.lastErrorCode || "—"}</td>
                      <td><Button variant="ghost" onClick={() => void openEvent(item)}>{t.operations.btnViewEventDetail}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <Modal open={Boolean(selectedEvent)} onClose={() => setSelectedEvent(null)} title={t.operations.modalEventDetailTitle} description={selectedEvent?.externalEventId} wide>
        {selectedEvent ? (
          <div className="diagnostic-detail">
            <div className="metric-grid compact">
              <div><span>{t.operations.modalEventDetailColType}</span><strong>{selectedEvent.eventType}</strong></div>
              <div><span>{t.operations.modalEventDetailColStatus}</span><strong><StatusBadge status={selectedEvent.status} /></strong></div>
              <div><span>{t.operations.modalEventDetailColProvider}</span><strong>{selectedEvent.provider} · {selectedEvent.environment}</strong></div>
              <div><span>{t.operations.modalEventDetailColReceivedAt}</span><strong>{formatDate(selectedEvent.receivedAt)}</strong></div>
            </div>
            <section>
              <h3>{t.operations.modalEventDetailRelations}</h3>
              <pre>{safeJson({ customer: selectedEvent.externalCustomerId, transaction: selectedEvent.externalTransactionId, subscription: selectedEvent.externalSubscriptionId, adjustment: selectedEvent.externalAdjustmentId })}</pre>
            </section>
            <section>
              <h3>{t.operations.modalEventDetailDiagnostics}</h3>
              <pre>{safeJson(selectedEvent.lastError || (selectedEvent.lastErrorCode || selectedEvent.lastErrorDetail ? { code: selectedEvent.lastErrorCode, details: selectedEvent.lastErrorDetail } : null))}</pre>
            </section>
            {canManage && ["needs_attention", "failed"].includes(selectedEvent.status) ? (
              <div className="button-row">
                <Button loading={saving} onClick={() => setReplayConfirmTarget(selectedEvent)}>
                  <RotateCw className="size-4" />{t.operations.btnReplayEvent}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <ConfirmModal
        open={Boolean(replayConfirmTarget)}
        title={t.operations.modalReplayConfirmTitle}
        description={t.operations.modalReplayConfirmDesc(`${replayConfirmTarget?.eventType} · ${replayConfirmTarget?.externalEventId}`)}
        confirmLabel={t.operations.modalReplayConfirmBtn}
        variant="primary"
        loading={saving}
        onConfirm={handleConfirmReplay}
        onClose={() => setReplayConfirmTarget(null)}
      />
    </div>
  );
}
