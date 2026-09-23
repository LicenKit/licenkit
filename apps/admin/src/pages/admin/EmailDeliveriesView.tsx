import { useEffect, useState } from "react";
import { Ban, RefreshCw } from "lucide-react";
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
  EmptyState,
  ErrorPanel,
  LoadingState,
  Notice,
  PageHeader,
  StatusBadge,
  formatDate,
  safeJson,
} from "../../components/ui";

const STATUS_OPTIONS: Array<{ label: string; value: DeliveryStatus | "all" }> = [
  { label: "全部", value: "all" },
  { label: "等待配置", value: "waiting_configuration" },
  { label: "待发送", value: "pending" },
  { label: "处理中", value: "processing" },
  { label: "重试排队", value: "retry_scheduled" },
  { label: "已送达", value: "accepted" },
  { label: "失败", value: "failed" },
  { label: "已取消", value: "cancelled" },
  { label: "已过期", value: "expired" },
];

export function EmailDeliveriesView({ canManage }: { canManage: boolean }) {
  const [deliveries, setDeliveries] = useState<EmailDelivery[]>([]);
  const [statusFilter, setStatusFilter] = useState<DeliveryStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function load(selectedStatus = statusFilter) {
    setLoading(true);
    setError(null);
    try {
      const queryStatus = selectedStatus === "all" ? undefined : selectedStatus;
      const result = await api.admin.emailDeliveries.list(queryStatus);
      setDeliveries(result.items);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(statusFilter);
  }, [statusFilter]);

  async function retryDelivery(delivery: EmailDelivery) {
    const possibleDuplicate = mayDuplicateOnResend(delivery);
    if (possibleDuplicate && !window.confirm("上一次 Provider 请求结果未知，重发可能产生重复邮件。确认继续使用当前最新配置重发？")) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.emailDeliveries.retry(delivery.id, possibleDuplicate);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function cancelDelivery(delivery: EmailDelivery) {
    if (!window.confirm("取消后将立即清除敏感内容，并且不能再次重发。确认取消发送？")) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.emailDeliveries.cancel(delivery.id);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <ErrorPanel error={error} />

      <Card>
        <div className="card-header">
          <div>
            <p className="eyebrow">Email queue & history</p>
            <h2>邮件投递记录</h2>
            <p>每封业务邮件只有一条记录；attempt_count 是计数器。按状态过滤直接下推至持久层查询。</p>
          </div>
          <div className="button-row">
            <Badge>{deliveries.length} 条记录</Badge>
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              <RefreshCw className="size-4" />刷新
            </Button>
          </div>
        </div>

        <Notice>
          <strong>重发使用最新配置</strong>
          <p>Delivery 只保留收件人和加密业务变量。Provider 请求结果未知时不会自动重发；人工重发必须确认可能重复。</p>
        </Notice>

        <div className="filter-bar">
          <div className="tabs" role="tablist">
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.value}
                role="tab"
                aria-selected={statusFilter === option.value}
                className={statusFilter === option.value ? "active" : ""}
                onClick={() => setStatusFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {loading && deliveries.length === 0 ? (
          <LoadingState label="正在读取邮件投递记录" />
        ) : deliveries.length === 0 ? (
          <EmptyState
            title={statusFilter === "all" ? "暂无 Email Delivery" : `暂无“${STATUS_OPTIONS.find((opt) => opt.value === statusFilter)?.label}”状态的投递记录`}
            description="发码、Magic Link 或安全重置产生邮件时会在这里出现。"
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Delivery</th>
                  <th>客户 / 收件人</th>
                  <th>合同</th>
                  <th>状态</th>
                  <th>尝试次数</th>
                  <th>时间</th>
                  <th></th>
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
                      {deliveryRecipientLabel(delivery)}
                      <small>{delivery.recipientEmail}</small>
                    </td>
                    <td>
                      {delivery.notificationType}
                      <small>v{delivery.contractVersion}</small>
                    </td>
                    <td>
                      <StatusBadge status={delivery.status} label={deliveryStatusLabel(delivery.status)} />
                      <small>{deliveryStatusExplanation(delivery.status)}</small>
                    </td>
                    <td>{delivery.attemptCount}</td>
                    <td>
                      {delivery.nextAttemptAt ? formatDate(delivery.nextAttemptAt) : formatDate(delivery.createdAt)}
                      {delivery.sendExpiresAt && delivery.status !== "accepted" ? (
                        <small>最晚发送 {formatDate(delivery.sendExpiresAt)}</small>
                      ) : null}
                      {delivery.variablesExpiresAt ? (
                        <small>敏感内容清理 {formatDate(delivery.variablesExpiresAt)}</small>
                      ) : !delivery.sendExpiresAt && !["accepted", "expired", "cancelled"].includes(delivery.status) ? (
                        <small>发送成功前保留敏感内容</small>
                      ) : null}
                    </td>
                    <td>
                      <div className="button-row wrap">
                        {canManage && canRetryDelivery(delivery) ? (
                          <Button
                            variant={mayDuplicateOnResend(delivery) ? "danger" : "secondary"}
                            loading={saving}
                            onClick={() => void retryDelivery(delivery)}
                          >
                            <RefreshCw className="size-4" />
                            {mayDuplicateOnResend(delivery) ? "确认后重发" : "重发"}
                          </Button>
                        ) : null}
                        {canManage && canCancelDelivery(delivery) ? (
                          <Button variant="danger" loading={saving} onClick={() => void cancelDelivery(delivery)}>
                            <Ban className="size-4" />取消发送
                          </Button>
                        ) : null}
                      </div>
                      {delivery.lastError ? (
                        <details>
                          <summary>诊断</summary>
                          <pre>{safeJson(delivery.lastError)}</pre>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
