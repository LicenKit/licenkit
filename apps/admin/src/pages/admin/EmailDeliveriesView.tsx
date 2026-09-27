import { type FormEvent, useEffect, useState } from "react";
import { Ban, RefreshCw, Search } from "lucide-react";
import {
  api,
  type DeliveryStatus,
  type EmailDelivery,
} from "../../lib/api-client";
import {
  canCancelDelivery,
  canRetryDelivery,
  deliveryRecipientLabel,
  deliveryStatusExplanation,
  deliveryStatusLabel,
  mayDuplicateOnResend,
} from "../../lib/email-delivery";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  ErrorPanel,
  Input,
  LoadingState,
  Notice,
  PaginationBar,
  Select,
  StatusBadge,
  safeJson,
} from "../../components/ui";
import { useI18n } from "../../lib/i18n";

export function EmailDeliveriesView({ canManage }: { canManage: boolean }) {
  const { t, formatDate } = useI18n();
  const [deliveries, setDeliveries] = useState<EmailDelivery[]>([]);
  const [statusFilter, setStatusFilter] = useState<DeliveryStatus | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [retryConfirmTarget, setRetryConfirmTarget] = useState<{ delivery: EmailDelivery; duplicate: boolean } | null>(null);
  const [cancelConfirmTarget, setCancelConfirmTarget] = useState<EmailDelivery | null>(null);

  const statusOptions: Array<{ label: string; value: DeliveryStatus | "all" }> = [
    { label: t.email.filterAllStatuses, value: "all" },
    { label: t.email.statusWaitingConfig, value: "waiting_configuration" },
    { label: t.email.statusPending, value: "pending" },
    { label: t.email.statusProcessing, value: "processing" },
    { label: t.email.statusRetryScheduled, value: "retry_scheduled" },
    { label: t.email.statusAccepted, value: "accepted" },
    { label: t.email.statusFailed, value: "failed" },
    { label: t.email.statusCancelled, value: "cancelled" },
    { label: t.email.statusExpired, value: "expired" },
  ];

  async function load(targetPage = page, selectedStatus = statusFilter) {
    setLoading(true);
    setError(null);
    try {
      const queryStatus = selectedStatus === "all" ? undefined : selectedStatus;
      const result = await api.admin.emailDeliveries.list({
        page: targetPage,
        limit: 20,
        status: queryStatus,
        query: searchQuery.trim() || undefined,
      });
      setDeliveries(result.items);
      if (result.pagination) {
        setPage(result.pagination.page);
        setTotalPages(result.pagination.totalPages);
        setTotalItems(result.pagination.total);
      } else {
        setPage(targetPage);
        setTotalPages(1);
        setTotalItems(result.items.length);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(1, statusFilter);
  }, [statusFilter]);

  function handleSearchSubmit(event: FormEvent) {
    event.preventDefault();
    void load(1);
  }

  async function handleConfirmRetry() {
    if (!retryConfirmTarget) return;
    const { delivery, duplicate } = retryConfirmTarget;
    setSaving(true);
    setError(null);
    try {
      await api.admin.emailDeliveries.retry(delivery.id, duplicate);
      setRetryConfirmTarget(null);
      await load(page);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmCancel() {
    if (!cancelConfirmTarget) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.emailDeliveries.cancel(cancelConfirmTarget.id);
      setCancelConfirmTarget(null);
      await load(page);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <ErrorPanel error={error} onClose={() => setError(null)} />

      <Card>
        <div className="card-header">
          <div>
            <p className="eyebrow">{t.email.deliveriesEyebrow}</p>
            <h2>{t.email.deliveriesTitle}</h2>
            <p>{t.email.deliveriesDesc}</p>
          </div>
          <div className="button-row">
            <Button variant="secondary" loading={loading} onClick={() => void load(page)}>
              <RefreshCw className="size-4" />{t.common.refresh}
            </Button>
          </div>
        </div>

        {deliveries.length > 0 ? (
          <Notice tone="info">
            <strong>{t.email.resendNoticeTitle}</strong>
            <p>{t.email.resendNoticeDesc}</p>
          </Notice>
        ) : null}

        {/* 顶部搜索与状态过滤栏 */}
        <div className="filter-bar">
          <form className="filter-group" onSubmit={handleSearchSubmit}>
            <div className="filter-search">
              <Input
                placeholder={t.email.filterSearchPlaceholder}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            <Button variant="secondary" type="submit">
              <Search className="size-4" />{t.common.search}
            </Button>
          </form>

          <div className="filter-group">
            <Select
              className="filter-select"
              aria-label={t.email.filterAllStatuses}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as DeliveryStatus | "all")}
            >
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <Badge>{t.email.totalDeliveriesCount(totalItems)}</Badge>
        </div>

        {loading && deliveries.length === 0 ? (
          <LoadingState />
        ) : deliveries.length === 0 ? (
          <EmptyState
            title={
              searchQuery.trim()
                ? t.email.emptyDeliveriesSearchTitle
                : statusFilter === "all"
                ? t.email.emptyDeliveriesTitle
                : t.email.emptyDeliveriesStatusTitle(statusOptions.find((opt) => opt.value === statusFilter)?.label || "")
            }
            description={
              searchQuery.trim()
                ? t.email.emptyDeliveriesSearchDesc
                : t.email.emptyDeliveriesDesc
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t.email.tableColId}</th>
                    <th>{t.email.tableColRecipient}</th>
                    <th>{t.email.tableColType}</th>
                    <th>{t.email.tableColStatus}</th>
                    <th>{t.email.tableColAttempts}</th>
                    <th>{t.email.tableColTime}</th>
                    <th>{t.email.tableColActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <td>
                        <strong>{delivery.id}</strong>
                        <small>{delivery.providerMessageId || "—"}</small>
                      </td>
                      <td>
                        {deliveryRecipientLabel(delivery, t.email)}
                        <small>{delivery.recipientEmail}</small>
                      </td>
                      <td>
                        {delivery.notificationType}
                        <small>v{delivery.contractVersion}</small>
                      </td>
                      <td>
                        <StatusBadge status={delivery.status} label={deliveryStatusLabel(delivery.status, t.email)} />
                        <small>{deliveryStatusExplanation(delivery.status, t.email)}</small>
                      </td>
                      <td>{delivery.attemptCount}</td>
                      <td>
                        {delivery.nextAttemptAt ? formatDate(delivery.nextAttemptAt) : formatDate(delivery.createdAt)}
                        {delivery.sendExpiresAt && delivery.status !== "accepted" ? (
                          <small>{t.email.latestSendTime(formatDate(delivery.sendExpiresAt))}</small>
                        ) : null}
                        {delivery.variablesExpiresAt ? (
                          <small>{t.email.sensitiveRetainUntil(formatDate(delivery.variablesExpiresAt))}</small>
                        ) : !delivery.sendExpiresAt && !["accepted", "expired", "cancelled"].includes(delivery.status) ? (
                          <small>{t.email.sensitiveRetainPending}</small>
                        ) : null}
                      </td>
                      <td>
                        <div className="button-row wrap">
                          {canManage && canRetryDelivery(delivery) ? (
                            <Button
                              variant={mayDuplicateOnResend(delivery) ? "danger" : "secondary"}
                              loading={saving}
                              onClick={() => {
                                const duplicate = mayDuplicateOnResend(delivery);
                                if (duplicate) {
                                  setRetryConfirmTarget({ delivery, duplicate: true });
                                } else {
                                  void api.admin.emailDeliveries.retry(delivery.id, false).then(() => load(page));
                                }
                              }}
                            >
                              <RefreshCw className="size-4" />
                              {mayDuplicateOnResend(delivery) ? t.email.btnRetryDuplicate : t.email.btnRetry}
                            </Button>
                          ) : null}
                          {canManage && canCancelDelivery(delivery) ? (
                            <Button
                              variant="danger"
                              loading={saving}
                              onClick={() => setCancelConfirmTarget(delivery)}
                            >
                              <Ban className="size-4" />{t.email.btnCancelDelivery}
                            </Button>
                          ) : null}
                        </div>
                        {delivery.lastError ? (
                          <details>
                            <summary>{t.email.btnDiagnostics}</summary>
                            <pre>{safeJson(delivery.lastError)}</pre>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar
              page={page}
              totalPages={totalPages}
              totalItems={totalItems}
              onPageChange={(newPage) => void load(newPage)}
              loading={loading}
            />
          </>
        )}
      </Card>

      <ConfirmModal
        open={Boolean(retryConfirmTarget)}
        title={t.email.confirmRetryTitle}
        description={t.email.confirmRetryDesc}
        confirmLabel={t.email.confirmRetryBtn}
        variant="danger"
        loading={saving}
        onConfirm={handleConfirmRetry}
        onClose={() => setRetryConfirmTarget(null)}
      />

      <ConfirmModal
        open={Boolean(cancelConfirmTarget)}
        title={t.email.confirmCancelTitle}
        description={t.email.confirmCancelDesc(cancelConfirmTarget?.recipientEmail || "")}
        confirmLabel={t.email.confirmCancelBtn}
        variant="danger"
        loading={saving}
        onConfirm={handleConfirmCancel}
        onClose={() => setCancelConfirmTarget(null)}
      />
    </div>
  );
}
