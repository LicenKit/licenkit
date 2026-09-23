import { useEffect, useState, type FormEvent } from "react";
import { Archive, FileClock, Layers3, Plus, RefreshCw } from "lucide-react";
import { api, type CredentialMode, type LicenseModel, type LicensePlan, type Product } from "../../lib/api-client";
import {
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  ErrorPanel,
  Field,
  Input,
  LoadingState,
  Modal,
  Notice,
  PageHeader,
  Select,
  StatusBadge,
  formatDurationSeconds,
} from "../../components/ui";

const emptyForm = {
  productId: "", name: "", licenseModel: "perpetual" as LicenseModel, credentialMode: "opaque" as CredentialMode,
  maxActivations: "1", features: "", updateWindowSeconds: "", defaultTermSeconds: "",
  signedTokenTtlSeconds: "2592000", paymentGraceSeconds: "",
};

export const MIN_SIGNED_TOKEN_TTL_SECONDS = 1;

export function LicensePlansView({ canWrite }: { canWrite: boolean }) {
  const [plans, setPlans] = useState<LicensePlan[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
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

  async function handleConfirmArchive() {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      await api.admin.licensePlans.archive(selected.id);
      setArchiveConfirmOpen(false);
      await load();
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="授权目录"
        title="授权方案"
        description="授权方案是签发模板，定义了授权生命周期、激活上限与凭证模式。后续对方案的修改不会变更已签发的历史授权条款。"
        action={
          <div className="button-row">
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              <RefreshCw className="size-4" />刷新
            </Button>
            {canWrite ? (
              <Button onClick={() => setModalOpen(true)}>
                <Plus className="size-4" />新建授权方案
              </Button>
            ) : null}
          </div>
        }
      />
      <ErrorPanel error={error} />
      {loading && plans.length === 0 ? <LoadingState /> : plans.length === 0 ? (
        <EmptyState
          title="暂无授权方案"
          description="请先选择产品，再配置对应的授权模型、有效期限与凭证签发能力。"
        />
      ) : (
        <div className="master-detail">
          <aside className="master-list card">
            {plans.map((plan) => (
              <button
                className={plan.id === selectedId ? "master-item active" : "master-item"}
                key={plan.id}
                onClick={() => setSelectedId(plan.id)}
              >
                <span className="item-icon"><Layers3 className="size-4" /></span>
                <div>
                  <strong>{plan.name}</strong>
                  <small>
                    {plan.licenseModel === "perpetual" ? "永久买断" : plan.licenseModel === "fixed_term" ? "固定期限" : "周期订阅"} · 第 {plan.revision} 版
                  </small>
                </div>
                <StatusBadge status={plan.status} label={plan.status === "active" ? "生效中" : "已归档"} />
              </button>
            ))}
          </aside>
          {selected ? (
            <div className="detail-stack">
              <Card>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">方案详情 · 第 {selected.revision} 版</p>
                    <h2>{selected.name}</h2>
                    <p>{products.find((product) => product.id === selected.productId)?.name || selected.productId}</p>
                  </div>
                  <StatusBadge status={selected.status} label={selected.status === "active" ? "生效中" : "已归档"} />
                </div>
                <div className="metric-grid compact">
                  <div>
                    <span>授权模型</span>
                    <strong>{selected.licenseModel === "perpetual" ? "永久买断 (perpetual)" : selected.licenseModel === "fixed_term" ? "固定期限 (fixed_term)" : "周期订阅 (subscription)"}</strong>
                  </div>
                  <div>
                    <span>凭证签名模式</span>
                    <strong>{selected.credentialMode === "signed" ? "在线激活 + 离线签名凭证" : "仅在线激活 (opaque)"}</strong>
                  </div>
                  <div>
                    <span>最大激活设备数</span>
                    <strong>{selected.maxActivations} 台</strong>
                  </div>
                  <div>
                    <span>扣费宽限期</span>
                    <strong>{formatDurationSeconds(selected.paymentGraceSeconds)}</strong>
                  </div>
                  <div>
                    <span>版本更新权益期</span>
                    <strong>{selected.updateWindowSeconds === null ? "永久全版本更新" : formatDurationSeconds(selected.updateWindowSeconds)}</strong>
                  </div>
                  <div>
                    <span>离线凭证有效期</span>
                    <strong>{formatDurationSeconds(selected.signedTokenTtlSeconds)}</strong>
                  </div>
                </div>
                <div className="tag-list">
                  {selected.features.length ? selected.features.map((feature) => <span key={feature}>{feature}</span>) : <span>无附加特定功能</span>}
                </div>
                <Notice>
                  <strong>修改影响范围</strong>
                  <p>在此修改或产生新版本，仅对后续新签发的授权生效；已售出的存量授权条款将保持固化不变。</p>
                </Notice>
                {canWrite && selected.status === "active" ? (
                  <div className="button-row">
                    <Button variant="danger" loading={saving} onClick={() => setArchiveConfirmOpen(true)}>
                      <Archive className="size-4" />归档授权方案
                    </Button>
                  </div>
                ) : null}
              </Card>
              <Card>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">业务规则</p>
                    <h2>生命周期与更新说明</h2>
                  </div>
                  <FileClock className="size-5" />
                </div>
                <PlanExplanation plan={selected} />
              </Card>
            </div>
          ) : null}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="新建授权方案" description="定义新授权方案的签发规则。此操作不会直接签发授权。" wide>
        <form className="form-stack" onSubmit={create}>
          <div className="form-grid">
            <Field label="所属产品">
              <Select value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })} required>
                <option value="" disabled>选择产品</option>
                {products.filter((item) => item.status === "active").map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="方案名称">
              <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：专业版（年度）" required />
            </Field>
          </div>
          <div className="form-grid">
            <Field label="授权模型">
              <Select value={form.licenseModel} onChange={(event) => setForm({ ...form, licenseModel: event.target.value as LicenseModel })}>
                <option value="perpetual">perpetual · 永久买断制</option>
                <option value="fixed_term">fixed_term · 固定期限</option>
                <option value="subscription">subscription · 周期订阅制</option>
              </Select>
            </Field>
            <Field label="凭证模式">
              <Select value={form.credentialMode} onChange={(event) => setForm({ ...form, credentialMode: event.target.value as CredentialMode })}>
                <option value="opaque">opaque · 仅在线机器码激活</option>
                <option value="signed">signed · 额外签发离线签名凭证</option>
              </Select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label="最大允许激活设备数">
              <Input type="number" min="1" value={form.maxActivations} onChange={(event) => setForm({ ...form, maxActivations: event.target.value })} required />
            </Field>
            <Field label="功能白名单列表" hint="用英文逗号分隔，如 pro_export,batch">
              <Input value={form.features} onChange={(event) => setForm({ ...form, features: event.target.value })} placeholder="pro_export,batch" />
            </Field>
          </div>
          {form.licenseModel === "perpetual" ? (
            <Field label="版本更新权益期（秒）" hint="买断后支持更新软件版本的期限。留空表示永久享受所有未来版本更新（如 31536000 为 1 年）">
              <Input type="number" min="1" value={form.updateWindowSeconds} onChange={(event) => setForm({ ...form, updateWindowSeconds: event.target.value })} />
            </Field>
          ) : null}
          {form.licenseModel === "fixed_term" ? (
            <Field label="默认固定有效期（秒）" hint="如 2592000 为 30 天，31536000 为 365 天">
              <Input type="number" min="1" value={form.defaultTermSeconds} onChange={(event) => setForm({ ...form, defaultTermSeconds: event.target.value })} required />
            </Field>
          ) : null}
          {form.licenseModel === "subscription" ? (
            <Field label="订阅扣费宽限期（秒）" hint="扣费失败后的缓冲期。在此期间客户端仍可正常校验通过（如 259200 为 3 天）">
              <Input type="number" min="0" value={form.paymentGraceSeconds} onChange={(event) => setForm({ ...form, paymentGraceSeconds: event.target.value })} />
            </Field>
          ) : null}
          {form.credentialMode === "signed" ? (
            <Field label="离线凭证有效期 TTL（秒）" hint="离线签名凭证有效时长。客户端需在到期前联网重新同步（如 2592000 为 30 天）">
              <Input type="number" min={MIN_SIGNED_TOKEN_TTL_SECONDS} value={form.signedTokenTtlSeconds} onChange={(event) => setForm({ ...form, signedTokenTtlSeconds: event.target.value })} required />
            </Field>
          ) : null}
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>取消</Button>
            <Button loading={saving} type="submit">创建授权方案</Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={archiveConfirmOpen}
        title="归档授权方案"
        description={`确定归档授权方案“${selected?.name}”？归档后该方案将无法继续签发新授权，但已签发的历史授权条款不受任何影响。`}
        confirmLabel="确认归档"
        variant="danger"
        loading={saving}
        onConfirm={handleConfirmArchive}
        onClose={() => setArchiveConfirmOpen(false)}
      />
    </div>
  );
}

function PlanExplanation({ plan }: { plan: LicensePlan }) {
  if (plan.licenseModel === "perpetual") {
    return (
      <p className="explanation">
        永久买断授权不设过期时间。
        {plan.updateWindowSeconds === null
          ? "该方案支持使用与升级所有未来发布的软件版本。"
          : `签发后享有 ${formatDurationSeconds(plan.updateWindowSeconds)} 内发布的版本更新权益，到期后仍可永久使用历史已支持的版本。`}
      </p>
    );
  }
  if (plan.licenseModel === "fixed_term") {
    return (
      <p className="explanation">
        固定期限授权。签发时按指定期限（{formatDurationSeconds(plan.defaultTermSeconds)}）设定到期时间，到期后授权终止且不支持自动续期。
      </p>
    );
  }
  return (
    <p className="explanation">
      周期订阅授权。手动签发需指定单期到期时间；通过 Paddle 支付履约的授权将根据订阅扣费结果自动维护续期状态。
    </p>
  );
}
