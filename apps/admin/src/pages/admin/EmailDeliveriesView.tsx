import { useEffect, useMemo, useState } from "react";
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
  Field,
  Input,
  LoadingState,
  Notice,
  PageHeader,
  Select,
  StatusBadge,
  formatDate,
  safeJson,
} from "../../components/ui";

const STATUS_OPTIONS: Array<{ label: string; value: DeliveryStatus | "all" }> = [
  { label: "全部状态", value: "all" },
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
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [retryConfirmTarget, setRetryConfirmTarget] = useState<{ delivery: EmailDelivery; duplicate: boolean } | null>(null);
  const [cancelConfirmTarget, setCancelConfirmTarget] = useState<EmailDelivery | null>(null);

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

  const filteredDeliveries = useMemo(() => {
    if (!searchQuery.trim()) return deliveries;
    const q = searchQuery.trim().toLowerCase();
    return deliveries.filter((item) => {
      return (
        item.id.toLowerCase().includes(q) ||
        item.recipientEmail.toLowerCase().includes(q) ||
        (item.providerMessageId?.toLowerCase().includes(q) ?? false) ||
        item.notificationType.toLowerCase().includes(q)
      );
    });
  }, [deliveries, searchQuery]);

  async function handleConfirmRetry() {
    if (!retryConfirmTarget) return;
    const { delivery, duplicate } = retryConfirmTarget;
    setSaving(true);
    setError(null);
    try {
      await api.admin.emailDeliveries.retry(delivery.id, duplicate);
      setRetryConfirmTarget(null);
      await load();
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
            <p className="eyebrow">邮件队列与状态</p>
            <h2>邮件投递记录</h2>
            <p>追踪系统外发邮件的处理进度、重发队列与最终投递结果。</p>
          </div>
          <div className="button-row">
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              <RefreshCw className="size-4" />刷新
            </Button>
          </div>
        </div>

        {deliveries.length > 0 ? (
          <Notice tone="info">
            <strong>重发机制说明</strong>
            <p>手动重发将使用当前最新保存的发信通道配置。对于结果未知的投递任务，请在确认可能重复后再执行重发。</p>
          </Notice>
        ) : null}

        {/* 顶部搜索与状态过滤栏 */}
        <div className="filter-bar">
          <div className="filter-group">
            <div className="filter-search">
              <Input
                placeholder="搜索收件人邮箱或投递 ID..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            <Select
              className="filter-select"
              aria-label="按投递状态筛选"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as DeliveryStatus | "all")}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <Badge>{filteredDeliveries.length} 条记录</Badge>
        </div>

        {loading && deliveries.length === 0 ? (
          <LoadingState label="正在读取邮件投递记录" />
        ) : filteredDeliveries.length === 0 ? (
          <EmptyState
            title={
              searchQuery.trim()
                ? "未找到匹配的投递记录"
                : statusFilter === "all"
                ? "暂无邮件投递记录"
                : `暂无“${STATUS_OPTIONS.find((opt) => opt.value === statusFilter)?.label}”状态的记录`
            }
            description={
              searchQuery.trim()
                ? "请尝试更换搜索关键字或清除过滤条件。"
                : "签发授权码、发送验证链接或系统重置时产生的邮件将显示在此处。"
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>投递 ID</th>
                  <th>收件人</th>
                  <th>邮件类型</th>
                  <th>投递状态</th>
                  <th>重试次数</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredDeliveries.map((delivery) => (
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
                        <small>敏感内容保留至 {formatDate(delivery.variablesExpiresAt)}</small>
                      ) : !delivery.sendExpiresAt && !["accepted", "expired", "cancelled"].includes(delivery.status) ? (
                        <small>发送成功前保留内容</small>
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
                                void api.admin.emailDeliveries.retry(delivery.id, false).then(() => load());
                              }
                            }}
                          >
                            <RefreshCw className="size-4" />
                            {mayDuplicateOnResend(delivery) ? "核对后重发" : "重发"}
                          </Button>
                        ) : null}
                        {canManage && canCancelDelivery(delivery) ? (
                          <Button
                            variant="danger"
                            loading={saving}
                            onClick={() => setCancelConfirmTarget(delivery)}
                          >
                            <Ban className="size-4" />取消发送
                          </Button>
                        ) : null}
                      </div>
                      {delivery.lastError ? (
                        <details>
                          <summary>诊断信息</summary>
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

      <ConfirmModal
        open={Boolean(retryConfirmTarget)}
        title="确认重发邮件"
        description="上一次向发信服务商发送的请求结果未知。继续重发可能会导致客户收到重复邮件，是否确认使用当前通道配置强制重发？"
        confirmLabel="确认继续重发"
        variant="danger"
        loading={saving}
        onConfirm={handleConfirmRetry}
        onClose={() => setRetryConfirmTarget(null)}
      />

      <ConfirmModal
        open={Boolean(cancelConfirmTarget)}
        title="取消外发邮件"
        description={`确定取消发送该邮件（${cancelConfirmTarget?.recipientEmail}）？取消后系统将清理暂存的敏感数据，且该记录不能再次重发。`}
        confirmLabel="确认取消发送"
        variant="danger"
        loading={saving}
        onConfirm={handleConfirmCancel}
        onClose={() => setCancelConfirmTarget(null)}
      />
    </div>
  );
}
