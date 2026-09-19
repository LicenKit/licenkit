import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Copy, ExternalLink, Plus, RefreshCw, RotateCw, Send, Webhook } from "lucide-react";
import { api, type InboundEvent, type OutboundDelivery, type OutboundEndpoint } from "../../lib/api-client";
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, Select, StatusBadge, formatDate, safeJson } from "../../components/ui";

type Tab = "endpoints" | "events" | "deliveries";
const notificationEvents = ["customer.license_issued", "customer.license_recovered", "customer.license_security_reset", "customer.portal_access_requested"];

export function OperationsView({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<Tab>("endpoints");
  const [endpoints, setEndpoints] = useState<OutboundEndpoint[]>([]);
  const [events, setEvents] = useState<InboundEvent[]>([]);
  const [deliveries, setDeliveries] = useState<OutboundDelivery[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<InboundEvent | null>(null);
  const [selectedDelivery, setSelectedDelivery] = useState<OutboundDelivery | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [endpointModal, setEndpointModal] = useState(false);
  const [endpointForm, setEndpointForm] = useState({
    endpointType: "notification_gateway" as "notification_gateway" | "event_subscriber",
    name: "",
    url: "",
    subscribedEvents: "license.issued",
    timeoutMs: "10000",
    maxAutomaticAttempts: "4",
  });
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    const results = await Promise.allSettled([api.admin.outbound.endpoints.list(), api.admin.billing.events.list(), api.admin.outbound.deliveries.list()]);
    if (results[0].status === "fulfilled") setEndpoints(results[0].value.items);
    if (results[1].status === "fulfilled") setEvents(results[1].value.items);
    if (results[2].status === "fulfilled") setDeliveries(results[2].value.items);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason);
    setLoading(false);
  }
  useEffect(() => { void load() }, []);

  async function createEndpoint(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const result = await api.admin.outbound.endpoints.create({
        endpointType: endpointForm.endpointType,
        name: endpointForm.name.trim(),
        url: endpointForm.url.trim(),
        subscribedEvents: endpointForm.endpointType === "notification_gateway"
          ? notificationEvents
          : endpointForm.subscribedEvents.split(",").map((item) => item.trim()).filter(Boolean),
        timeoutMs: Number(endpointForm.timeoutMs),
        maxAutomaticAttempts: Number(endpointForm.maxAutomaticAttempts),
      });
      setOneTimeSecret(result.signingSecret || null);
      setEndpointModal(false);
      setEndpointForm({ ...endpointForm, name: "", url: "" });
      await load();
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function testEndpoint(endpoint: OutboundEndpoint) {
    setSaving(true); setError(null);
    try { await api.admin.outbound.endpoints.test(endpoint.id); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function openEvent(item: InboundEvent) {
    setError(null);
    try { setSelectedEvent(await api.admin.billing.events.get(item.id)) } catch (caught) { setError(caught) }
  }
  async function replayEvent(item: InboundEvent) {
    if (!window.confirm("重新执行同一条持久化事件？幂等唯一键仍然生效，不会复制事件。")) return;
    setSaving(true); setError(null);
    try { const result = await api.admin.billing.events.replay(item.id); setSelectedEvent(result); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }
  async function openDelivery(item: OutboundDelivery) {
    setError(null);
    try { setSelectedDelivery(await api.admin.outbound.deliveries.get(item.id)) } catch (caught) { setError(caught) }
  }
  async function retryDelivery(item: OutboundDelivery) {
    setSaving(true); setError(null);
    try { await api.admin.outbound.deliveries.retry(item.id); setSelectedDelivery(await api.admin.outbound.deliveries.get(item.id)); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }
  async function resumeDelivery(item: OutboundDelivery) {
    setSaving(true); setError(null);
    try { await api.admin.outbound.deliveries.resume(item.id); setSelectedDelivery(await api.admin.outbound.deliveries.get(item.id)); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="可恢复任务事实" title="事件与投递诊断" description="Inbound Event、Delivery 和每次 HTTP Attempt 分别保留状态与原始来源；重放不会绕过幂等约束。" action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>} />
      <ErrorPanel error={error} />
      {oneTimeSecret ? <div className="credential-reveal"><div><p className="eyebrow">仅显示一次</p><h2>Webhook 签名 Secret</h2><p>请立即交给接收方安全保存。已有 Delivery 会继续使用创建时固化的 Secret 快照。</p></div><code>{oneTimeSecret}</code><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(oneTimeSecret)}><Copy className="size-4" />复制 Secret</Button><Button variant="ghost" onClick={() => setOneTimeSecret(null)}>我已保存</Button></div> : null}
      <div className="tabs">{(["endpoints", "events", "deliveries"] as Tab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item === "endpoints" ? "Notification Gateway" : item === "events" ? "Inbound Event" : "Outbound Delivery"}</button>)}</div>
      {loading && endpoints.length + events.length + deliveries.length === 0 ? <LoadingState /> : null}

      {tab === "endpoints" ? <Card><div className="card-header"><div><p className="eyebrow">公网 HTTPS</p><h2>Outbound Endpoint</h2><p>LicenKit 只发送语义化通知 Webhook，不集成邮件供应商。</p></div>{canManage ? <Button onClick={() => setEndpointModal(true)}><Plus className="size-4" />配置 Endpoint</Button> : null}</div>{endpoints.length === 0 ? <EmptyState title="还没有 Notification Gateway" description="Offer 激活与公开 Checkout 都会因此不可用；异常付款仍会履约并创建 blocked_configuration Delivery。" /> : <div className="card-grid">{endpoints.map((endpoint) => <article className="entity-card" key={endpoint.id}><header><div><strong>{endpoint.name || endpoint.endpointType}</strong><span>{endpoint.endpointType} · {endpoint.id}</span></div><StatusBadge status={endpoint.status} /></header><a className="endpoint-url" href={endpoint.url} target="_blank" rel="noreferrer"><ExternalLink className="size-4" />{endpoint.url}</a><div className="metric-grid compact"><div><span>自动尝试预算</span><strong>{endpoint.maxAutomaticAttempts}</strong></div><div><span>超时</span><strong>{endpoint.timeoutMs} ms</strong></div><div><span>最近测试</span><strong>{formatDate(endpoint.lastTestedAt)}</strong></div><div><span>测试状态</span><strong><StatusBadge status={endpoint.lastTestStatus} /></strong></div></div>{canManage ? <Button variant="secondary" loading={saving} onClick={() => void testEndpoint(endpoint)}><Send className="size-4" />运行 Endpoint Test</Button> : null}</article>)}</div>}</Card> : null}

      {tab === "events" ? <Card><div className="card-header"><div><p className="eyebrow">Payment ingress</p><h2>Inbound Event</h2><p>事件状态与 provider 原始类型、外部 ID 和错误来源一起保留。</p></div><Badge>{events.length}</Badge></div>{events.length === 0 ? <EmptyState title="暂无入站事件" description="已验签且可靠持久化的 Paddle Webhook 会出现在这里。" /> : <div className="table-wrap"><table><thead><tr><th>事件</th><th>外部引用</th><th>环境</th><th>状态</th><th>最近错误</th><th></th></tr></thead><tbody>{events.map((item) => <tr key={item.id}><td><strong>{item.eventType}</strong><small>{formatDate(item.receivedAt)}</small></td><td><code>{item.externalEventId}</code><small>{item.externalTransactionId || item.externalSubscriptionId || item.externalCustomerId || "—"}</small></td><td>{item.provider} · {item.environment}</td><td><StatusBadge status={item.status} /></td><td>{item.lastError?.code || item.lastErrorCode || "—"}<small>{item.lastError?.requestId || item.lastError?.externalEventId || ""}</small></td><td><Button variant="ghost" onClick={() => void openEvent(item)}>诊断</Button></td></tr>)}</tbody></table></div>}</Card> : null}

      {tab === "deliveries" ? <Card><div className="card-header"><div><p className="eyebrow">Transactional outbox</p><h2>Outbound Delivery</h2><p>License 履约与注册码通知是两种状态；accepted 只表示外部接收方已可靠接管。</p></div><Badge>{deliveries.length}</Badge></div>{deliveries.length === 0 ? <EmptyState title="暂无 Delivery" description="签发、找回、安全重置和 Magic Link 会创建对应 Delivery。" /> : <div className="table-wrap"><table><thead><tr><th>Delivery</th><th>类型 / 收件人</th><th>状态</th><th>Attempt</th><th>负载到期</th><th></th></tr></thead><tbody>{deliveries.map((item) => <tr key={item.id}><td><strong>{item.id}</strong><small>{formatDate(item.createdAt)}</small></td><td>{item.type}<small>{item.recipient?.email || "—"}</small></td><td><StatusBadge status={item.status} /></td><td>{item.automaticAttemptCount} / {item.maxAutomaticAttempts}</td><td>{formatDate(item.payloadExpiresAt)}</td><td><Button variant="ghost" onClick={() => void openDelivery(item)}>诊断</Button></td></tr>)}</tbody></table></div>}</Card> : null}

      <Modal open={endpointModal} onClose={() => setEndpointModal(false)} title="配置 Outbound Endpoint" description="V1 只允许公网 HTTPS，不支持 localhost、私网或非标准端口。">
        <form className="form-stack" onSubmit={createEndpoint}>
          <div className="form-grid">
            <Field label="Endpoint 名称"><Input value={endpointForm.name} onChange={(event) => setEndpointForm({ ...endpointForm, name: event.target.value })} placeholder="Primary notification gateway" required /></Field>
            <Field label="Endpoint 类型"><Select value={endpointForm.endpointType} onChange={(event) => setEndpointForm({ ...endpointForm, endpointType: event.target.value as "notification_gateway" | "event_subscriber" })}><option value="notification_gateway">notification_gateway</option><option value="event_subscriber">event_subscriber</option></Select></Field>
          </div>
          <Field label="接收 URL"><Input type="url" value={endpointForm.url} onChange={(event) => setEndpointForm({ ...endpointForm, url: event.target.value })} placeholder="https://merchant.example.com/hooks/licenkit-notifications" required /></Field>
          {endpointForm.endpointType === "event_subscriber" ? <Field label="订阅事件" hint="使用逗号分隔业务事件名称"><Input value={endpointForm.subscribedEvents} onChange={(event) => setEndpointForm({ ...endpointForm, subscribedEvents: event.target.value })} placeholder="license.issued, license.revoked" required /></Field> : null}
          <div className="form-grid"><Field label="超时（毫秒）"><Input type="number" min="1000" max="30000" value={endpointForm.timeoutMs} onChange={(event) => setEndpointForm({ ...endpointForm, timeoutMs: event.target.value })} required /></Field><Field label="最大自动 Attempt" hint="包含首次请求；默认 4 即失败后再重试 3 次"><Input type="number" min="1" max="20" value={endpointForm.maxAutomaticAttempts} onChange={(event) => setEndpointForm({ ...endpointForm, maxAutomaticAttempts: event.target.value })} required /></Field></div>
          {endpointForm.endpointType === "notification_gateway" ? <Notice><Webhook className="size-4" /><strong>通知事件</strong><p>{notificationEvents.join(" · ")}</p></Notice> : null}
          <div className="form-actions"><Button variant="secondary" type="button" onClick={() => setEndpointModal(false)}>取消</Button><Button type="submit" loading={saving}>创建 Endpoint</Button></div>
        </form>
      </Modal>

      <Modal open={Boolean(selectedEvent)} onClose={() => setSelectedEvent(null)} title="Inbound Event 诊断" description={selectedEvent?.externalEventId} wide>
        {selectedEvent ? <div className="diagnostic-detail"><div className="metric-grid compact"><div><span>类型</span><strong>{selectedEvent.eventType}</strong></div><div><span>状态</span><strong><StatusBadge status={selectedEvent.status} /></strong></div><div><span>Provider</span><strong>{selectedEvent.provider} · {selectedEvent.environment}</strong></div><div><span>接收时间</span><strong>{formatDate(selectedEvent.receivedAt)}</strong></div></div><section><h3>外部关联</h3><pre>{safeJson({ customer: selectedEvent.externalCustomerId, transaction: selectedEvent.externalTransactionId, subscription: selectedEvent.externalSubscriptionId, adjustment: selectedEvent.externalAdjustmentId })}</pre></section><section><h3>最近错误（保留原始详情）</h3><pre>{safeJson(selectedEvent.lastError || (selectedEvent.lastErrorCode || selectedEvent.lastErrorDetail ? { code: selectedEvent.lastErrorCode, details: selectedEvent.lastErrorDetail } : null))}</pre></section>{canManage && ["needs_attention", "failed", "pending"].includes(selectedEvent.status) ? <Button loading={saving} onClick={() => void replayEvent(selectedEvent)}><RotateCw className="size-4" />修复依赖后 Replay</Button> : null}</div> : null}
      </Modal>

      <Modal open={Boolean(selectedDelivery)} onClose={() => setSelectedDelivery(null)} title="Delivery 诊断" description={selectedDelivery?.id} wide>
        {selectedDelivery ? <div className="diagnostic-detail"><div className="metric-grid compact"><div><span>消息类型</span><strong>{selectedDelivery.type}</strong></div><div><span>状态</span><strong><StatusBadge status={selectedDelivery.status} /></strong></div><div><span>自动 Attempt</span><strong>{selectedDelivery.automaticAttemptCount} / {selectedDelivery.maxAutomaticAttempts}</strong></div><div><span>负载到期</span><strong>{formatDate(selectedDelivery.payloadExpiresAt)}</strong></div></div><section><h3>最近错误</h3><pre>{safeJson(selectedDelivery.lastError || null)}</pre></section><section><h3>HTTP Attempt</h3>{selectedDelivery.attempts?.length ? <div className="stack-list">{selectedDelivery.attempts.map((attempt) => <div className="stack-row" key={attempt.id}>{attempt.httpStatus && attempt.httpStatus >= 200 && attempt.httpStatus < 300 ? <CheckCircle2 className="size-5 text-emerald-400" /> : <Send className="size-5" />}<div className="grow"><strong>#{attempt.sequence} · {attempt.source}</strong><span>{formatDate(attempt.attemptedAt)} · HTTP {attempt.httpStatus || "transport error"}</span></div>{attempt.error ? <code>{attempt.error.code}</code> : null}</div>)}</div> : <p>尚未产生 HTTP Attempt。</p>}</section>{canManage ? <div className="button-row">{selectedDelivery.status === "failed" ? <Button loading={saving} onClick={() => void retryDelivery(selectedDelivery)}><RefreshCw className="size-4" />追加一次人工 retry</Button> : null}{selectedDelivery.status === "blocked_configuration" && (selectedDelivery.attemptCount ?? 0) === 0 ? <Button loading={saving} onClick={() => void resumeDelivery(selectedDelivery)}>绑定当前 Gateway 并发送</Button> : null}</div> : null}</div> : null}
      </Modal>
    </div>
  );
}
