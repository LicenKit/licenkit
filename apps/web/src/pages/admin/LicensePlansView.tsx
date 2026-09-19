import { useEffect, useState, type FormEvent } from "react";
import { Archive, FileClock, Layers3, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { api, type CredentialMode, type LicenseModel, type LicensePlan, type Product } from "../../lib/api-client";
import { Button, Card, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, Select, StatusBadge } from "../../components/ui";

const emptyForm = {
  productId: "", name: "", licenseModel: "perpetual" as LicenseModel, credentialMode: "opaque" as CredentialMode,
  maxActivations: "1", features: "", updateWindowSeconds: "", defaultTermSeconds: "",
  signedTokenTtlSeconds: "2592000", paymentGraceSeconds: "",
};

export function LicensePlansView({ canWrite }: { canWrite: boolean }) {
  const [plans, setPlans] = useState<LicensePlan[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const selected = plans.find((plan) => plan.id === selectedId) ?? null;

  async function load() {
    setLoading(true); setError(null);
    try {
      const [planResult, productResult] = await Promise.all([api.admin.licensePlans.list(), api.admin.products.list()]);
      setPlans(planResult.items); setProducts(productResult.items);
      setSelectedId((current) => current && planResult.items.some((item) => item.id === current) ? current : planResult.items[0]?.id ?? null);
      setForm((current) => ({ ...current, productId: current.productId || productResult.items[0]?.id || "" }));
    } catch (caught) { setError(caught) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, []);

  async function create(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      await api.admin.licensePlans.create({
        productId: form.productId, name: form.name.trim(), licenseModel: form.licenseModel, credentialMode: form.credentialMode,
        maxActivations: Number(form.maxActivations), features: form.features.split(",").map((item) => item.trim()).filter(Boolean),
        updateWindowSeconds: form.licenseModel === "perpetual" && form.updateWindowSeconds ? Number(form.updateWindowSeconds) : null,
        defaultTermSeconds: form.licenseModel === "fixed_term" ? Number(form.defaultTermSeconds) : null,
        signedTokenTtlSeconds: form.credentialMode === "signed" ? Number(form.signedTokenTtlSeconds) : 0,
        paymentGraceSeconds: form.licenseModel === "subscription" && form.paymentGraceSeconds !== "" ? Number(form.paymentGraceSeconds) : undefined,
      });
      setModalOpen(false); setForm({ ...emptyForm, productId: products[0]?.id || "" }); await load();
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function archive() {
    if (!selected || !window.confirm(`归档授权方案“${selected.name}”？它只会停止新签发，不改变已签发 License Terms。`)) return;
    setSaving(true); setError(null);
    try { await api.admin.licensePlans.archive(selected.id); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="未来签发模板" title="授权方案" description="授权方案可以编辑；每次签发会生成固化的 License Terms，后续模板 revision 不会追溯修改已售合同。" action={<div className="button-row"><Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>{canWrite ? <Button onClick={() => setModalOpen(true)}><Plus className="size-4" />新建授权方案</Button> : null}</div>} />
      <ErrorPanel error={error} />
      {loading && plans.length === 0 ? <LoadingState /> : plans.length === 0 ? <EmptyState title="还没有授权方案" description="先创建 Product，再为未来签发定义生命周期和凭证能力。" /> : (
        <div className="master-detail">
          <aside className="master-list card">{plans.map((plan) => <button className={plan.id === selectedId ? "master-item active" : "master-item"} key={plan.id} onClick={() => setSelectedId(plan.id)}><span className="item-icon"><Layers3 className="size-4" /></span><div><strong>{plan.name}</strong><small>{plan.licenseModel} · rev {plan.revision}</small></div><StatusBadge status={plan.status} /></button>)}</aside>
          {selected ? <div className="detail-stack">
            <Card>
              <div className="card-header"><div><p className="eyebrow">License Plan · revision {selected.revision}</p><h2>{selected.name}</h2><p>{products.find((product) => product.id === selected.productId)?.name || selected.productId}</p></div><StatusBadge status={selected.status} /></div>
              <div className="metric-grid compact">
                <div><span>授权模型</span><strong>{selected.licenseModel}</strong></div>
                <div><span>凭证模式</span><strong>{selected.credentialMode}</strong></div>
                <div><span>最大激活数</span><strong>{selected.maxActivations}</strong></div>
                <div><span>支付宽限期</span><strong>{selected.paymentGraceSeconds} 秒</strong></div>
                <div><span>版本更新窗口</span><strong>{selected.updateWindowSeconds === null ? "永久全版本" : `${selected.updateWindowSeconds} 秒`}</strong></div>
                <div><span>Signed Token TTL</span><strong>{selected.signedTokenTtlSeconds} 秒</strong></div>
              </div>
              <div className="tag-list">{selected.features.length ? selected.features.map((feature) => <span key={feature}>{feature}</span>) : <span>无附加功能</span>}</div>
              <Notice><ShieldCheck className="size-4" /><strong>编辑影响边界</strong><p>新 revision 只用于之后签发的 License。存量条款只能通过显式迁移操作改变。</p></Notice>
              {canWrite && selected.status === "active" ? <div className="button-row"><Button variant="danger" loading={saving} onClick={() => void archive()}><Archive className="size-4" />归档授权方案</Button></div> : null}
            </Card>
            <Card><div className="card-header"><div><p className="eyebrow">签发行为</p><h2>生命周期摘要</h2></div><FileClock className="size-5" /></div><PlanExplanation plan={selected} /></Card>
          </div> : null}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="新建授权方案" description="这是未来签发模板，不会直接创建 License。" wide>
        <form className="form-stack" onSubmit={create}>
          <div className="form-grid"><Field label="Product"><Select value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })} required><option value="" disabled>选择 Product</option>{products.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="方案名称"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Pro Annual" required /></Field></div>
          <div className="form-grid"><Field label="授权模型"><Select value={form.licenseModel} onChange={(event) => setForm({ ...form, licenseModel: event.target.value as LicenseModel })}><option value="perpetual">perpetual · 永久</option><option value="fixed_term">fixed_term · 固定期限</option><option value="subscription">subscription · 可续期周期</option></Select></Field><Field label="凭证模式"><Select value={form.credentialMode} onChange={(event) => setForm({ ...form, credentialMode: event.target.value as CredentialMode })}><option value="opaque">opaque · 仅 Machine Token</option><option value="signed">signed · 额外签发离线凭证</option></Select></Field></div>
          <div className="form-grid"><Field label="最大激活数"><Input type="number" min="1" value={form.maxActivations} onChange={(event) => setForm({ ...form, maxActivations: event.target.value })} required /></Field><Field label="功能列表" hint="英文逗号分隔"><Input value={form.features} onChange={(event) => setForm({ ...form, features: event.target.value })} placeholder="pro_export,batch_processing" /></Field></div>
          {form.licenseModel === "perpetual" ? <Field label="版本更新窗口（秒）" hint="留空表示永久使用所有未来版本"><Input type="number" min="1" value={form.updateWindowSeconds} onChange={(event) => setForm({ ...form, updateWindowSeconds: event.target.value })} /></Field> : null}
          {form.licenseModel === "fixed_term" ? <Field label="默认固定期限（秒）"><Input type="number" min="1" value={form.defaultTermSeconds} onChange={(event) => setForm({ ...form, defaultTermSeconds: event.target.value })} required /></Field> : null}
          {form.licenseModel === "subscription" ? <Field label="支付宽限期（秒）" hint="留空时由服务端读取当前 Account 默认值并保存解析值"><Input type="number" min="0" value={form.paymentGraceSeconds} onChange={(event) => setForm({ ...form, paymentGraceSeconds: event.target.value })} /></Field> : null}
          {form.credentialMode === "signed" ? <Field label="Signed License Token TTL（秒）"><Input type="number" min="1" value={form.signedTokenTtlSeconds} onChange={(event) => setForm({ ...form, signedTokenTtlSeconds: event.target.value })} required /></Field> : null}
          <div className="form-actions"><Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>取消</Button><Button loading={saving} type="submit">创建授权方案</Button></div>
        </form>
      </Modal>
    </div>
  );
}

function PlanExplanation({ plan }: { plan: LicensePlan }) {
  if (plan.licenseModel === "perpetual") return <p className="explanation">永久 License 没有 expiresAt。{plan.updateWindowSeconds === null ? "该方案不限制未来版本。" : "签发时会把相对更新窗口固化为绝对 updatesUntil。"}</p>;
  if (plan.licenseModel === "fixed_term") return <p className="explanation">签发时按 {plan.defaultTermSeconds || 0} 秒计算一次到期时间，renewalMode 固定为 none。</p>;
  return <p className="explanation">手动签发必须提供未来 expiresAt，renewalMode 为 manual 且支付宽限期固化为 0；支付履约签发则由 Billing Subscription 推进周期。</p>;
}
