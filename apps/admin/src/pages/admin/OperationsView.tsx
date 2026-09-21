import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, RotateCw } from "lucide-react";
import { api, type InboundEvent, type SystemIssue } from "../../lib/api-client";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  LoadingState,
  Modal,
  PageHeader,
  StatusBadge,
  formatDate,
  safeJson,
} from "../../components/ui";
import { EmailDeliveryPanel } from "./EmailDeliveryPanel";

type Tab = "issues" | "email" | "events";

export function OperationsView({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<Tab>("issues");
  const [issues, setIssues] = useState<SystemIssue[]>([]);
  const [events, setEvents] = useState<InboundEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<InboundEvent | null>(null);
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

  async function replayEvent(item: InboundEvent) {
    if (!window.confirm("重新执行同一条持久化事件？幂等唯一键仍然生效，不会复制事件。")) return;
    setSaving(true);
    setError(null);
    try {
      setSelectedEvent(await api.admin.billing.events.replay(item.id));
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
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="运行事实" title="系统事件与邮件" description="System Issue 只记录最近发生的错误，不参与业务重试；回调和邮件由各自记录维护真实状态。" action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>} />
      <ErrorPanel error={error} />
      <div className="tabs">{(["issues", "email", "events"] as Tab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item === "issues" ? "问题提示" : item === "email" ? "Email Delivery" : "Inbound Event"}</button>)}</div>
      {loading && issues.length + events.length === 0 ? <LoadingState /> : null}

      {tab === "issues" ? <Card><div className="card-header"><div><p className="eyebrow">Recent operational errors</p><h2>问题提示</h2><p>管理员可将问题标记为已处理；同一问题再次发生时会重新变为待处理。</p></div><Badge tone={issues.some((item) => item.status === "pending") ? "warning" : "neutral"}>{issues.filter((item) => item.status === "pending").length} 待处理</Badge></div>{issues.length === 0 ? <EmptyState title="暂无错误记录" description="需要管理员关注的运行错误会出现在这里。" /> : <div className="table-wrap"><table><thead><tr><th>类别</th><th>错误</th><th>状态</th><th>来源</th><th>发生</th><th>最近时间</th><th></th></tr></thead><tbody>{issues.map((item) => <tr key={item.id}><td><Badge tone="warning">{item.category}</Badge></td><td><strong>{item.errorCode}</strong><small>{item.operation}</small></td><td><StatusBadge status={item.status} label={item.status === "pending" ? "待处理" : "已处理"} /></td><td>{item.sourceType}<small>{item.sourceId}</small></td><td>{item.occurrenceCount}</td><td>{formatDate(item.lastSeenAt)}<small>首次 {formatDate(item.firstSeenAt)}</small></td><td>{canManage && item.status === "pending" ? <Button variant="secondary" loading={saving} onClick={() => void processIssue(item)}><CheckCircle2 className="size-4" />已处理</Button> : null}<details><summary>诊断</summary><pre>{safeJson(item.error)}</pre></details></td></tr>)}</tbody></table></div>}</Card> : null}

      {tab === "email" ? <EmailDeliveryPanel canManage={canManage} /> : null}

      {tab === "events" ? <Card><div className="card-header"><div><p className="eyebrow">Payment ingress</p><h2>Inbound Event</h2><p>Event 自己保存处理状态和最近错误；修复依赖后由管理员显式 Replay。</p></div><Badge>{events.length}</Badge></div>{events.length === 0 ? <EmptyState title="暂无入站事件" description="已验签并持久化的 Paddle Webhook 会出现在这里。" /> : <div className="table-wrap"><table><thead><tr><th>事件</th><th>外部引用</th><th>环境</th><th>状态</th><th>最近错误</th><th></th></tr></thead><tbody>{events.map((item) => <tr key={item.id}><td><strong>{item.eventType}</strong><small>{formatDate(item.receivedAt)}</small></td><td><code>{item.externalEventId}</code><small>{item.externalTransactionId || item.externalSubscriptionId || item.externalCustomerId || "—"}</small></td><td>{item.provider} · {item.environment}</td><td><StatusBadge status={item.status} /></td><td>{item.lastError?.code || item.lastErrorCode || "—"}</td><td><Button variant="ghost" onClick={() => void openEvent(item)}>诊断</Button></td></tr>)}</tbody></table></div>}</Card> : null}

      <Modal open={Boolean(selectedEvent)} onClose={() => setSelectedEvent(null)} title="Inbound Event 诊断" description={selectedEvent?.externalEventId} wide>
        {selectedEvent ? <div className="diagnostic-detail"><div className="metric-grid compact"><div><span>类型</span><strong>{selectedEvent.eventType}</strong></div><div><span>状态</span><strong><StatusBadge status={selectedEvent.status} /></strong></div><div><span>Provider</span><strong>{selectedEvent.provider} · {selectedEvent.environment}</strong></div><div><span>接收时间</span><strong>{formatDate(selectedEvent.receivedAt)}</strong></div></div><section><h3>外部关联</h3><pre>{safeJson({ customer: selectedEvent.externalCustomerId, transaction: selectedEvent.externalTransactionId, subscription: selectedEvent.externalSubscriptionId, adjustment: selectedEvent.externalAdjustmentId })}</pre></section><section><h3>最近错误</h3><pre>{safeJson(selectedEvent.lastError || (selectedEvent.lastErrorCode || selectedEvent.lastErrorDetail ? { code: selectedEvent.lastErrorCode, details: selectedEvent.lastErrorDetail } : null))}</pre></section>{canManage && ["needs_attention", "failed"].includes(selectedEvent.status) ? <Button loading={saving} onClick={() => void replayEvent(selectedEvent)}><RotateCw className="size-4" />修复依赖后 Replay</Button> : null}</div> : null}
      </Modal>
    </div>
  );
}
