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
  formatDate,
  safeJson,
} from "../../components/ui";

type Tab = "issues" | "events";

export function OperationsView({ canManage, onIssuesChanged }: { canManage: boolean; onIssuesChanged?: () => void }) {
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
        eyebrow="运维监控"
        title="系统运维与事件"
        description="集中监控系统运行异常与外部 Webhook 入站事件。在排查并修复依赖后，可在此安全重试执行异常事件。"
        action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>}
      />
      <ErrorPanel error={error} />
      <div className="tabs">
        {(["issues", "events"] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item === "issues" ? "异常提示" : "入站事件"}
          </button>
        ))}
      </div>
      {loading && issues.length + events.length === 0 ? <LoadingState /> : null}

      {tab === "issues" ? (
        <Card>
          <div className="card-header">
            <div>
              <p className="eyebrow">运行异常排查</p>
              <h2>系统异常提示</h2>
              <p>问题解决后可标记为已处理。若同一异常后续再次发生，系统将自动恢复为待处理状态。</p>
            </div>
            <Badge tone={issues.some((item) => item.status === "pending") ? "warning" : "neutral"}>
              {issues.filter((item) => item.status === "pending").length} 待处理
            </Badge>
          </div>
          {issues.length === 0 ? (
            <EmptyState title="暂无系统异常" description="系统运行健康，没有需要管理员关注的未处理异常。" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>业务类别</th>
                    <th>错误代码</th>
                    <th>状态</th>
                    <th>来源</th>
                    <th>发生次数</th>
                    <th>最近时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((item) => (
                    <tr key={item.id}>
                      <td><Badge tone="warning">{item.category}</Badge></td>
                      <td><strong>{item.errorCode}</strong><small>{item.operation}</small></td>
                      <td><StatusBadge status={item.status} label={item.status === "pending" ? "待处理" : "已处理"} /></td>
                      <td>{item.sourceType}<small>{item.sourceId}</small></td>
                      <td>{item.occurrenceCount} 次</td>
                      <td>{formatDate(item.lastSeenAt)}<small>首次 {formatDate(item.firstSeenAt)}</small></td>
                      <td>
                        <div className="button-row wrap">
                          {canManage && item.status === "pending" ? (
                            <Button variant="secondary" loading={saving} onClick={() => void processIssue(item)}>
                              <CheckCircle2 className="size-4" />标记已处理
                            </Button>
                          ) : null}
                          <details>
                            <summary>诊断信息</summary>
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
              <p className="eyebrow">Webhook 接入记录</p>
              <h2>入站事件</h2>
              <p>记录由支付服务商已验签发送的通知事件及其处理状态。支持依赖修复后的人工安全重新执行。</p>
            </div>
            <Badge>{events.length} 条记录</Badge>
          </div>
          {events.length === 0 ? (
            <EmptyState title="暂无入站事件" description="来自支付服务商的已验签通知事件将显示在此处。" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>事件类型</th>
                    <th>外部标识</th>
                    <th>通道与环境</th>
                    <th>处理状态</th>
                    <th>最近错误</th>
                    <th>操作</th>
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
                      <td><Button variant="ghost" onClick={() => void openEvent(item)}>查看详情</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <Modal open={Boolean(selectedEvent)} onClose={() => setSelectedEvent(null)} title="入站事件排查详情" description={selectedEvent?.externalEventId} wide>
        {selectedEvent ? (
          <div className="diagnostic-detail">
            <div className="metric-grid compact">
              <div><span>事件类型</span><strong>{selectedEvent.eventType}</strong></div>
              <div><span>处理状态</span><strong><StatusBadge status={selectedEvent.status} /></strong></div>
              <div><span>服务商与环境</span><strong>{selectedEvent.provider} · {selectedEvent.environment}</strong></div>
              <div><span>接收时间</span><strong>{formatDate(selectedEvent.receivedAt)}</strong></div>
            </div>
            <section>
              <h3>外部业务关联</h3>
              <pre>{safeJson({ customer: selectedEvent.externalCustomerId, transaction: selectedEvent.externalTransactionId, subscription: selectedEvent.externalSubscriptionId, adjustment: selectedEvent.externalAdjustmentId })}</pre>
            </section>
            <section>
              <h3>最近错误诊断</h3>
              <pre>{safeJson(selectedEvent.lastError || (selectedEvent.lastErrorCode || selectedEvent.lastErrorDetail ? { code: selectedEvent.lastErrorCode, details: selectedEvent.lastErrorDetail } : null))}</pre>
            </section>
            {canManage && ["needs_attention", "failed"].includes(selectedEvent.status) ? (
              <div className="button-row">
                <Button loading={saving} onClick={() => setReplayConfirmTarget(selectedEvent)}>
                  <RotateCw className="size-4" />重新执行此事件
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <ConfirmModal
        open={Boolean(replayConfirmTarget)}
        title="确认重新执行入站事件"
        description={`确定重新执行事件（${replayConfirmTarget?.eventType} · ${replayConfirmTarget?.externalEventId}）？系统将按幂等规则重新触发处理流程，不会造成重复记录。`}
        confirmLabel="重新执行"
        variant="primary"
        loading={saving}
        onConfirm={handleConfirmReplay}
        onClose={() => setReplayConfirmTarget(null)}
      />
    </div>
  );
}
