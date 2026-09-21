import { useEffect, useState, type FormEvent } from "react";
import { Ban, Copy, KeyRound, Laptop, PauseCircle, Plus, RefreshCw, RotateCw, ShieldAlert, ShieldCheck, TimerReset } from "lucide-react";
import { api, type Activation, type IssuedLicenseResponse, type KeyRotationResponse, type License, type LicensePlan } from "../../lib/api-client";
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, Select, StatusBadge, formatDate } from "../../components/ui";

export function LicensesView({ canManage, canSupport }: { canManage: boolean; canSupport: boolean }) {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [plans, setPlans] = useState<LicensePlan[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<License | null>(null);
  const [activations, setActivations] = useState<Activation[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [issueModal, setIssueModal] = useState(false);
  const [issueForm, setIssueForm] = useState({ licensePlanId: "", customerEmail: "", expiresAt: "" });
  const [oneTimeResult, setOneTimeResult] = useState<IssuedLicenseResponse | KeyRotationResponse | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [licenseResult, planResult] = await Promise.all([api.admin.licenses.list({ limit: 100 }), api.admin.licensePlans.list()]);
      setLicenses(licenseResult.items); setPlans(planResult.items);
      setSelectedId((current) => current && licenseResult.items.some((item) => item.id === current) ? current : licenseResult.items[0]?.id ?? null);
      setIssueForm((current) => ({ ...current, licensePlanId: current.licensePlanId || planResult.items.find((item) => item.status === "active")?.id || "" }));
    } catch (caught) { setError(caught) } finally { setLoading(false) }
  }

  async function loadDetail(id: string) {
    setError(null);
    try {
      const [licenseResult, activationResult] = await Promise.all([api.admin.licenses.get(id), api.admin.licenses.activations(id)]);
      setDetail(licenseResult); setActivations(activationResult.items);
    } catch (caught) { setError(caught) }
  }

  useEffect(() => { void load() }, []);
  useEffect(() => { setOneTimeResult(null); if (selectedId) void loadDetail(selectedId); else { setDetail(null); setActivations([]) } }, [selectedId]);
  const issuePlan = plans.find((plan) => plan.id === issueForm.licensePlanId);

  async function issue(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const result = await api.admin.licenses.issue({
        licensePlanId: issueForm.licensePlanId, customerEmail: issueForm.customerEmail.trim(),
        expiresAt: issuePlan?.licenseModel === "subscription" ? new Date(issueForm.expiresAt).toISOString() : null,
        delivery: { sendNotification: true },
      });
      setOneTimeResult(result); setIssueModal(false); setIssueForm({ licensePlanId: issueForm.licensePlanId, customerEmail: "", expiresAt: "" });
      await load(); setSelectedId(result.license.id);
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function rotate(kind: "recover" | "reset") {
    if (!detail) return;
    const message = kind === "recover" ? "生成新注册码并发送？旧注册码立即失效，已有 active Activation 保留。" : "执行安全重置？旧注册码立即失效，全部 active Activation 会被吊销。";
    if (!window.confirm(message)) return;
    setSaving(true); setError(null);
    try {
      const result = kind === "recover" ? await api.admin.licenses.recoverKey(detail.id) : await api.admin.licenses.securityReset(detail.id);
      setOneTimeResult(result); await loadDetail(detail.id); await load();
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function stateAction(action: "suspend" | "reinstate" | "revoke") {
    if (!detail) return;
    const reason = window.prompt(action === "revoke" ? "请输入吊销原因。此操作不可作为临时暂停使用。" : `请输入${action === "suspend" ? "暂停" : "恢复"}原因（必填）。`, "");
    if (!reason?.trim()) return;
    setSaving(true); setError(null);
    try {
      if (action === "suspend") await api.admin.licenses.suspend(detail.id, reason.trim());
      if (action === "reinstate") await api.admin.licenses.reinstate(detail.id, reason.trim());
      if (action === "revoke") await api.admin.licenses.revoke(detail.id, reason.trim());
      await loadDetail(detail.id); await load();
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function renewTerm() {
    if (!detail) return;
    const expiresAt = window.prompt("输入新的绝对到期时间（ISO 8601）。新值必须晚于当前到期时间和当前时间。", detail.expiresAt || "");
    if (!expiresAt) return;
    const reason = window.prompt("输入续期原因。", "Manual renewal");
    if (!reason) return;
    setSaving(true); setError(null);
    try { await api.admin.licenses.renewTerm(detail.id, new Date(expiresAt).toISOString(), reason); await loadDetail(detail.id); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function extendUpdates() {
    if (!detail) return;
    const value = window.prompt("输入新的绝对 updatesUntil（ISO 8601），或输入 never 改为不限制未来版本。", detail.updatesUntil || "never");
    if (!value) return;
    const reason = window.prompt("输入延长版本更新权益的原因。", "Manual entitlement extension");
    if (!reason) return;
    setSaving(true); setError(null);
    try { await api.admin.licenses.extendUpdates(detail.id, value === "never" ? null : new Date(value).toISOString(), reason); await loadDetail(detail.id); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function revokeActivation(activation: Activation) {
    if (!detail) return;
    const reason = window.prompt(`吊销设备“${activation.name || activation.id}”的原因。`, "Support action");
    if (!reason) return;
    setSaving(true); setError(null);
    try { await api.admin.licenses.revokeActivation(detail.id, activation.id, reason); await loadDetail(detail.id) } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  const revealedKey = oneTimeResult ? "licenseKey" in oneTimeResult ? oneTimeResult.licenseKey : oneTimeResult.license.licenseKey : null;
  const resultDelivery = oneTimeResult?.delivery ?? null;

  return (
    <div className="page-stack">
      <PageHeader eyebrow="授权运营" title="License 与 Activation" description="License Terms 是签发时固化的实际权益。找回注册码与安全重置是两个独立动作。" action={<div className="button-row"><Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>{canManage ? <Button onClick={() => setIssueModal(true)}><Plus className="size-4" />手动签发</Button> : null}</div>} />
      <ErrorPanel error={error} />
      {revealedKey ? <div className="credential-reveal"><div><p className="eyebrow">仅显示一次</p><h2>注册码已生成</h2><p>通知状态：<StatusBadge status={resultDelivery?.status} /></p></div><code>{revealedKey}</code><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(revealedKey)}><Copy className="size-4" />复制注册码</Button><Button variant="ghost" onClick={() => setOneTimeResult(null)}>我已保存</Button></div> : null}
      {loading && licenses.length === 0 ? <LoadingState /> : licenses.length === 0 ? <EmptyState title="还没有 License" description="可以手动签发，或由已验签支付事件履约创建。" /> : (
        <div className="master-detail">
          <aside className="master-list card">{licenses.map((license) => <button className={license.id === selectedId ? "master-item active" : "master-item"} key={license.id} onClick={() => setSelectedId(license.id)}><span className="item-icon"><KeyRound className="size-4" /></span><div><strong>{license.productName || license.productId}</strong><small>{license.customerEmail || license.customerId}</small></div><StatusBadge status={license.status} /></button>)}</aside>
          {detail ? <div className="detail-stack">
            <Card>
              <div className="card-header"><div><p className="eyebrow">License</p><h2>{detail.productName || detail.productId}</h2><p className="mono">{detail.id}</p></div><div className="button-row"><StatusBadge status={detail.status} />{detail.isCheckoutVerification ? <Badge tone="warning">checkout verification</Badge> : null}</div></div>
              <div className="metric-grid compact">
                <div><span>客户</span><strong>{detail.customerEmail || detail.customerId}</strong></div>
                <div><span>授权 / 续期</span><strong>{detail.licenseModel} · {detail.renewalMode}</strong></div>
                <div><span>到期时间</span><strong>{formatDate(detail.expiresAt)}</strong></div>
                <div><span>更新权益</span><strong>{detail.updatesUntil ? formatDate(detail.updatesUntil) : "不限制"}</strong></div>
                <div><span>Activation</span><strong>{detail.activeActivations ?? activations.filter((item) => item.status === "active").length} / {detail.maxActivations ?? detail.terms?.maxActivations ?? "—"}</strong></div>
                <div><span>首次通知</span><strong><StatusBadge status={detail.delivery?.status} /></strong></div>
              </div>
              <div className="terms-panel"><div><strong>固化 License Terms</strong><span>来源 {detail.licensePlanId || detail.terms?.sourceLicensePlanId || "—"} · revision {detail.planRevision ?? detail.terms?.sourceLicensePlanRevision ?? "—"}</span></div><dl><div><dt>credentialMode</dt><dd>{detail.credentialMode ?? detail.terms?.credentialMode ?? "—"}</dd></div><div><dt>paymentGraceSeconds</dt><dd>{detail.paymentGraceSeconds ?? detail.terms?.paymentGraceSeconds ?? "—"}</dd></div><div><dt>signedTokenTtlSeconds</dt><dd>{detail.signedTokenTtlSeconds ?? detail.terms?.signedTokenTtlSeconds ?? "—"}</dd></div><div><dt>features</dt><dd>{(detail.features ?? detail.terms?.features ?? []).join(", ") || "—"}</dd></div></dl></div>
              {canManage ? <div className="button-row wrap">
                <Button variant="secondary" loading={saving} onClick={() => void rotate("recover")}><RotateCw className="size-4" />生成新注册码并发送</Button>
                <Button variant="danger" loading={saving} onClick={() => void rotate("reset")}><ShieldAlert className="size-4" />安全重置</Button>
                {detail.status === "active" ? <Button variant="secondary" loading={saving} onClick={() => void stateAction("suspend")}><PauseCircle className="size-4" />暂停</Button> : detail.status === "suspended" && !detail.isCheckoutVerification ? <Button variant="secondary" loading={saving} onClick={() => void stateAction("reinstate")}><ShieldCheck className="size-4" />恢复</Button> : null}
                {detail.status !== "revoked" ? <Button variant="danger" loading={saving} onClick={() => void stateAction("revoke")}><Ban className="size-4" />吊销</Button> : null}
                {detail.licenseModel === "subscription" && detail.renewalMode === "manual" ? <Button variant="secondary" onClick={() => void renewTerm()}><TimerReset className="size-4" />手动续期</Button> : null}
                {detail.licenseModel === "perpetual" ? <Button variant="secondary" onClick={() => void extendUpdates()}>延长更新权益</Button> : null}
              </div> : null}
            </Card>
            <Card>
              <div className="card-header"><div><p className="eyebrow">Activation history</p><h2>设备激活</h2><p>吊销或释放只改变状态，历史记录不会删除。</p></div><Badge>{activations.length}</Badge></div>
              {activations.length === 0 ? <EmptyState title="尚无 Activation" description="客户端使用注册码成功激活后会出现在这里。" /> : <div className="stack-list">{activations.map((activation) => <div className="stack-row" key={activation.id}><Laptop className="size-5" /><div className="grow"><strong>{activation.name || "未命名设备"}</strong><span>{activation.platform || "未知平台"} · 最近验证 {formatDate(activation.lastValidatedAt)}</span></div><StatusBadge status={activation.status} />{canSupport && activation.status === "active" ? <Button variant="secondary" loading={saving} onClick={() => void revokeActivation(activation)}>吊销激活</Button> : null}</div>)}</div>}
            </Card>
          </div> : null}
        </div>
      )}

      <Modal open={issueModal} onClose={() => setIssueModal(false)} title="手动签发 License" description="客户邮箱必填；服务端按当前 Instance 查找或创建 Customer。">
        <form className="form-stack" onSubmit={issue}>
          <Field label="授权方案"><Select value={issueForm.licensePlanId} onChange={(event) => setIssueForm({ ...issueForm, licensePlanId: event.target.value })} required>{plans.filter((plan) => plan.status === "active").map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {plan.licenseModel}</option>)}</Select></Field>
          <Field label="客户邮箱"><Input type="email" value={issueForm.customerEmail} onChange={(event) => setIssueForm({ ...issueForm, customerEmail: event.target.value })} required /></Field>
          {issuePlan?.licenseModel === "subscription" ? <Field label="本期绝对到期时间" hint="手动订阅必须提供未来时间，paymentGraceSeconds 固化为 0"><Input type="datetime-local" value={issueForm.expiresAt} onChange={(event) => setIssueForm({ ...issueForm, expiresAt: event.target.value })} required /></Field> : null}
          {issuePlan?.licenseModel === "perpetual" ? <Notice><strong>永久 License</strong><p>expiresAt 必须为空，renewalMode 为 none。</p></Notice> : null}
          <Notice><strong>始终创建注册码通知 Delivery</strong><p>V1 手动签发合同固定 sendNotification=true；授权事实与通知状态分别返回，通知失败不会假装 License 未创建。</p></Notice>
          <div className="form-actions"><Button variant="secondary" type="button" onClick={() => setIssueModal(false)}>取消</Button><Button type="submit" loading={saving}>签发 License</Button></div>
        </form>
      </Modal>
    </div>
  );
}
