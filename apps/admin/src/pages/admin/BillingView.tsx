import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, CircleDollarSign, FlaskConical, Plus, RefreshCw, ShieldQuestion } from "lucide-react";
import { api, type BillingAdjustment, type BillingEnvironment, type BillingOffer, type BillingProvider, type BillingSubscription, type LicensePlan, type Product, type ProviderTestResult, type ReadinessReport } from "../../lib/api-client";
import { openVerificationCheckout } from "../../lib/verification-checkout";
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, Select, StatusBadge, formatDate } from "../../components/ui";

type Tab = "providers" | "offers" | "subscriptions" | "adjustments";

export function BillingView({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<Tab>("providers");
  const [providers, setProviders] = useState<BillingProvider[]>([]);
  const [offers, setOffers] = useState<BillingOffer[]>([]);
  const [subscriptions, setSubscriptions] = useState<BillingSubscription[]>([]);
  const [adjustments, setAdjustments] = useState<BillingAdjustment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [plans, setPlans] = useState<LicensePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [providerModal, setProviderModal] = useState(false);
  const [offerModal, setOfferModal] = useState(false);
  const [providerForm, setProviderForm] = useState({ environment: "sandbox" as BillingEnvironment, clientSideToken: "", webhookSecret: "", apiKey: "" });
  const [offerForm, setOfferForm] = useState({ billingProviderId: "", externalPriceId: "", productId: "", licensePlanId: "", purchaseType: "one_time" as "one_time" | "subscription" });
  const [providerTest, setProviderTest] = useState<ProviderTestResult | null>(null);
  const [verificationPending, setVerificationPending] = useState<{ offerId: string; expiresAt: string } | null>(null);

  const [resolvingAdjustment, setResolvingAdjustment] = useState<BillingAdjustment | null>(null);
  const [adjustmentAction, setAdjustmentAction] = useState<"no_action" | "keep_suspended" | "reinstate" | "revoke" | "security_reset">("keep_suspended");
  const [adjustmentReason, setAdjustmentReason] = useState("");

  async function load() {
    setLoading(true); setError(null);
    const results = await Promise.allSettled([
      api.admin.billing.providers.list(), api.admin.billing.offers.list(), api.admin.billing.subscriptions.list(),
      api.admin.billing.adjustments.list(), api.admin.products.list(), api.admin.licensePlans.list(),
    ]);
    if (results[0].status === "fulfilled") setProviders(results[0].value.items);
    if (results[1].status === "fulfilled") setOffers(results[1].value.items);
    if (results[2].status === "fulfilled") setSubscriptions(results[2].value.items);
    if (results[3].status === "fulfilled") setAdjustments(results[3].value.items);
    if (results[4].status === "fulfilled") setProducts(results[4].value.items);
    if (results[5].status === "fulfilled") setPlans(results[5].value.items);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason);
    const firstProvider = results[0].status === "fulfilled" ? results[0].value.items[0] : undefined;
    const firstProduct = results[4].status === "fulfilled" ? results[4].value.items[0] : undefined;
    const firstPlan = results[5].status === "fulfilled" ? results[5].value.items[0] : undefined;
    setOfferForm((current) => ({ ...current, billingProviderId: current.billingProviderId || firstProvider?.id || "", productId: current.productId || firstProduct?.id || "", licensePlanId: current.licensePlanId || firstPlan?.id || "" }));
    setLoading(false);
  }
  useEffect(() => { void load() }, []);

  async function createProvider(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      await api.admin.billing.providers.create({ provider: "paddle", environment: providerForm.environment, clientSideToken: providerForm.clientSideToken.trim(), webhookSecret: providerForm.webhookSecret, apiKey: providerForm.apiKey || undefined, status: "active" });
      setProviderModal(false); setProviderForm({ environment: "sandbox", clientSideToken: "", webhookSecret: "", apiKey: "" }); await load();
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function createOffer(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      await api.admin.billing.offers.create({ ...offerForm, externalPriceId: offerForm.externalPriceId.trim() });
      setOfferModal(false); setOfferForm({ ...offerForm, externalPriceId: "" }); await load();
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function testProvider(provider: BillingProvider) {
    setSaving(true); setError(null);
    try { setProviderTest(await api.admin.billing.providers.test(provider.id)) } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function activateOffer(offer: BillingOffer) {
    setSaving(true); setError(null);
    try { await api.admin.billing.offers.activate(offer.id); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function prepareVerification(offer: BillingOffer) {
    setSaving(true); setError(null);
    try {
      let expiresAt = "";
      await openVerificationCheckout(async () => {
        const response = await api.admin.billing.offers.verificationConfig(offer.id);
        expiresAt = response.data.expiresAt;
        return response;
      });
      setVerificationPending({ offerId: offer.id, expiresAt });
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function submitResolveAdjustment(event: FormEvent) {
    event.preventDefault();
    if (!resolvingAdjustment || !adjustmentReason.trim()) return;
    setSaving(true); setError(null);
    try {
      await api.admin.billing.adjustments.resolve(resolvingAdjustment.id, {
        action: adjustmentAction,
        reason: adjustmentReason.trim(),
      });
      setResolvingAdjustment(null);
      setAdjustmentReason("");
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  const tabLabels: Record<Tab, string> = {
    providers: "支付通道",
    offers: "定价方案与就绪",
    subscriptions: "订阅镜像",
    adjustments: "退款与争议",
  };

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="商业支付集成"
        title="支付通道与定价关联"
        description="连接 Paddle 支付网关；通过已验签 Webhook 将外部 Price ID 关联至产品与授权方案，保障交易自动履约与状态同步。"
        action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>}
      />
      <ErrorPanel error={error} />
      <div className="tabs" role="tablist">
        {(["providers", "offers", "subscriptions", "adjustments"] as Tab[]).map((item) => (
          <button role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
            {tabLabels[item]}
          </button>
        ))}
      </div>
      {loading && providers.length + offers.length + subscriptions.length + adjustments.length === 0 ? <LoadingState /> : null}

      {tab === "providers" ? <Card>
        <div className="card-header">
          <div>
            <p className="eyebrow">支付服务配置</p>
            <h2>Paddle 支付通道</h2>
            <p>沙盒 (Sandbox) 与正式 (Live) 环境是两条独立连接；创建后通道类型与运行环境不可更改。</p>
          </div>
          {canManage ? <Button onClick={() => setProviderModal(true)}><Plus className="size-4" />添加通道配置</Button> : null}
        </div>
        {providers.length === 0 ? <EmptyState title="未配置支付通道" description="发起在线购买至少需要配置 Client-side Token 与 Webhook Secret；API Key 仅供高级服务端能力使用。" /> : <div className="card-grid">{providers.map((provider) => <article className="entity-card" key={provider.id}><header><div><strong>Paddle {provider.environment === "sandbox" ? "沙盒环境 (Sandbox)" : "生产环境 (Live)"}</strong><span>{provider.id}</span></div><StatusBadge status={provider.status} /></header><div className="readiness-summary"><span>{provider.clientSideTokenConfigured ?? Boolean(provider.clientSideToken) ? <CheckCircle2 /> : <AlertTriangle />}Client-side Token</span><span>{provider.webhookSecretConfigured ? <CheckCircle2 /> : <AlertTriangle />}Webhook Secret</span><span>{provider.apiKeyConfigured ? <CheckCircle2 /> : <ShieldQuestion />}API Key（可选）</span></div>{provider.readiness ? <Readiness report={provider.readiness} /> : null}{canManage ? <Button variant="secondary" loading={saving} onClick={() => void testProvider(provider)}>测试通道连通性</Button> : null}</article>)}</div>}
      </Card> : null}

      {tab === "offers" ? <Card>
        <div className="card-header">
          <div>
            <p className="eyebrow">价格与方案映射</p>
            <h2>定价方案 (Offer)</h2>
            <p>新创建的定价方案默认为草稿 (draft)；通过结账就绪检查后方可激活用于线上收款。</p>
          </div>
          {canManage ? <Button onClick={() => setOfferModal(true)}><Plus className="size-4" />新建定价映射</Button> : null}
        </div>
        {verificationPending ? (
          <Notice tone="warning">
            <strong>正在等待沙盒结账验证</strong>
            <p>定价方案 {verificationPending.offerId} 的验证会话有效至 {formatDate(verificationPending.expiresAt)}。完成支付后，系统将自动核验已验签的 Webhook 履约与邮件通知发送。</p>
          </Notice>
        ) : null}
        {offers.length === 0 ? <EmptyState title="暂无定价方案" description="将 Paddle 的价格编号 (Price ID) 映射到具体的产品与授权方案。" /> : <div className="stack-list">{offers.map((offer) => {
          const provider = providers.find((item) => item.id === offer.billingProviderId);
          return <div className="offer-row" key={offer.id}><div className="offer-main"><div><strong>{offer.productName || products.find((item) => item.id === offer.productId)?.name || offer.productId}</strong><span>{offer.licensePlanName || plans.find((item) => item.id === offer.licensePlanId)?.name || offer.licensePlanId}</span></div><code>{offer.externalPriceId}</code></div><div className="offer-meta"><Badge>{offer.purchaseType === "subscription" ? "定期订阅" : "一次性买断"}</Badge><Badge>{provider?.environment || "未指定环境"}</Badge><StatusBadge status={offer.status} /><StatusBadge status={offer.readiness?.checkoutAvailable ? "ready" : "not_ready"} /></div>{offer.readiness ? <Readiness report={offer.readiness} /> : null}{canManage ? <div className="button-row wrap">{offer.status === "draft" && provider?.environment === "sandbox" ? <Button variant="secondary" loading={saving} onClick={() => void prepareVerification(offer)}><FlaskConical className="size-4" />发起沙盒模拟结账</Button> : null}{offer.status === "draft" ? <Button loading={saving} onClick={() => void activateOffer(offer)}>运行就绪检查并激活</Button> : null}</div> : null}</div>;
        })}</div>}
      </Card> : null}

      {tab === "subscriptions" ? <Card><div className="card-header"><div><p className="eyebrow">订阅数据同步</p><h2>订阅镜像 (Subscriptions)</h2><p>由支付服务推送的已验签 Webhook 驱动状态更新，保障账单周期与实际状态一致。</p></div><Badge>{subscriptions.length}</Badge></div>{subscriptions.length === 0 ? <EmptyState title="暂无订阅记录" description="用户在 Paddle 完成订阅购买或试用后，将在此展示同步的订阅状态。" /> : <div className="table-wrap"><table><thead><tr><th>外部订阅 ID</th><th>关联授权 / 客户</th><th>环境</th><th>状态</th><th>当前周期截止</th></tr></thead><tbody>{subscriptions.map((item) => <tr key={item.id}><td><strong>{item.externalSubscriptionId}</strong><small>{item.id}</small></td><td><span>{item.licenseId}</span><small>{item.customerId}</small></td><td>{item.environment}</td><td><StatusBadge status={item.status} /></td><td>{formatDate(item.currentPeriodEnd)}{item.cancelAtPeriodEnd ? <small>周期末自动取消</small> : null}</td></tr>)}</tbody></table></div>}</Card> : null}

      {tab === "adjustments" ? <Card><div className="card-header"><div><p className="eyebrow">资金与争议审计</p><h2>退款与争议记录 (Adjustments)</h2><p>完整保留支付网关上报的动作、类别及原始状态，支持管理员核实后实施针对性处置。</p></div><Badge>{adjustments.length}</Badge></div>{adjustments.length === 0 ? <EmptyState title="暂无退款或争议记录" description="发生的退款、信用返还、拒付或反转事件将记录在此处等待审计。" /> : <div className="table-wrap"><table><thead><tr><th>外部单号</th><th>原始网关状态</th><th>金额</th><th>系统联动影响</th><th>处置状态</th><th>操作</th></tr></thead><tbody>{adjustments.map((item) => <tr key={item.id}><td><strong>{item.externalAdjustmentId}</strong><small>{item.provider}</small></td><td>{item.action} · {item.type} · {item.status}</td><td>{item.amount || "—"} {item.currencyCode || ""}</td><td>{item.automaticEffect || "无自动动作"}<small>{item.licenseId || "未关联授权"}</small></td><td><StatusBadge status={item.reviewStatus} /></td><td>{canManage && item.reviewStatus === "open" ? <Button variant="secondary" loading={saving} onClick={() => { setResolvingAdjustment(item); setAdjustmentAction("keep_suspended"); setAdjustmentReason(""); }}>人工处置</Button> : null}</td></tr>)}</tbody></table></div>}</Card> : null}

      <Modal open={providerModal} onClose={() => setProviderModal(false)} title="连接 Paddle 支付通道" description="Client-side Token 用于前端结账组件；Webhook Secret 与 API Key 将在后端密文存储。">
        <form className="form-stack" onSubmit={createProvider}><Field label="运行环境"><Select value={providerForm.environment} onChange={(event) => setProviderForm({ ...providerForm, environment: event.target.value as BillingEnvironment })}><option value="sandbox">沙盒测试环境 (Sandbox)</option><option value="live">正式生产环境 (Live)</option></Select></Field><Field label="Client-side Token" hint="Paddle 开发者后台公开的前端凭据"><Input value={providerForm.clientSideToken} onChange={(event) => setProviderForm({ ...providerForm, clientSideToken: event.target.value })} autoComplete="off" required /></Field><Field label="Webhook Secret" hint="用于验证 Webhook 消息签名的密钥"><Input type="password" value={providerForm.webhookSecret} onChange={(event) => setProviderForm({ ...providerForm, webhookSecret: event.target.value })} autoComplete="new-password" required /></Field><Field label="Paddle API Key（可选）" hint="仅在需要读取客户资料、账单对账或托管门户时配置"><Input type="password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} autoComplete="new-password" /></Field><div className="form-actions"><Button variant="secondary" type="button" onClick={() => setProviderModal(false)}>取消</Button><Button type="submit" loading={saving}>保存通道配置</Button></div></form>
      </Modal>

      <Modal open={offerModal} onClose={() => setOfferModal(false)} title="新建定价方案映射" description="将支付平台中的 Price 对应到系统内的一个产品及授权方案。">
        <form className="form-stack" onSubmit={createOffer}><Field label="关联支付通道"><Select value={offerForm.billingProviderId} onChange={(event) => setOfferForm({ ...offerForm, billingProviderId: event.target.value })} required>{providers.map((item) => <option key={item.id} value={item.id}>Paddle {item.environment === "sandbox" ? "沙盒" : "生产"} ({item.id})</option>)}</Select></Field><Field label="Paddle Price ID" hint="以 pri_ 开头的价格标识符"><Input value={offerForm.externalPriceId} onChange={(event) => setOfferForm({ ...offerForm, externalPriceId: event.target.value })} placeholder="pri_…" required /></Field><div className="form-grid"><Field label="关联产品"><Select value={offerForm.productId} onChange={(event) => setOfferForm({ ...offerForm, productId: event.target.value })} required>{products.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="授权方案"><Select value={offerForm.licensePlanId} onChange={(event) => { const plan = plans.find((item) => item.id === event.target.value); setOfferForm({ ...offerForm, licensePlanId: event.target.value, purchaseType: plan?.licenseModel === "subscription" ? "subscription" : "one_time" }) }} required>{plans.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name} ({item.licenseModel === "subscription" ? "定期订阅" : "一次性买断"})</option>)}</Select></Field></div><Field label="购买类型"><Select value={offerForm.purchaseType} onChange={(event) => setOfferForm({ ...offerForm, purchaseType: event.target.value as "one_time" | "subscription" })}><option value="one_time">一次性买断 (One-time)</option><option value="subscription">定期订阅 (Subscription)</option></Select></Field><div className="form-actions"><Button variant="secondary" type="button" onClick={() => setOfferModal(false)}>取消</Button><Button type="submit" loading={saving}>保存为草稿</Button></div></form>
      </Modal>

      <Modal open={Boolean(providerTest)} onClose={() => setProviderTest(null)} title={providerTest ? `Paddle ${providerTest.environment === "sandbox" ? "沙盒" : "生产"}配置检查` : "支付通道检查"} description="此项检查验证凭证有效性与签名验签能力，不产生真实扣费或授权。">
        {providerTest ? <div className="readiness-list"><ProviderCheck label="Client-side Token 环境有效" value={providerTest.clientSideTokenValid} /><ProviderCheck label="Webhook Secret 可正常解密" value={providerTest.webhookSecretDecryptable} /><ProviderCheck label="Webhook 签名样本核验通过" value={providerTest.signatureSampleVerified} /><ProviderCheck label="服务端 API Key 已就绪（可选）" value={providerTest.apiKeyConfigured} /></div> : null}
      </Modal>

      <Modal
        open={Boolean(resolvingAdjustment)}
        onClose={() => { setResolvingAdjustment(null); setAdjustmentReason(""); }}
        title="人工处置退款与争议"
        description={resolvingAdjustment ? `外部单号：${resolvingAdjustment.externalAdjustmentId}，关联授权：${resolvingAdjustment.licenseId || "未关联"}` : ""}
      >
        <form onSubmit={submitResolveAdjustment} className="form-stack">
          <Field label="处置动作" hint="选择对当前授权与业务状态执行的操作">
            <Select value={adjustmentAction} onChange={(e) => setAdjustmentAction(e.target.value as any)}>
              <option value="keep_suspended">保持冻结 (Keep Suspended)</option>
              <option value="reinstate">恢复授权有效性 (Reinstate)</option>
              <option value="revoke">吊销授权 (Revoke)</option>
              <option value="security_reset">安全重置授权凭证 (Security Reset)</option>
              <option value="no_action">仅标记处理，不变更授权 (No Action)</option>
            </Select>
          </Field>
          <Field label="处理原因与依据" hint="必填，将记录在审计日志中">
            <Input
              value={adjustmentReason}
              onChange={(e) => setAdjustmentReason(e.target.value)}
              placeholder="请输入核实说明或工单编号..."
              required
            />
          </Field>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => { setResolvingAdjustment(null); setAdjustmentReason(""); }}>取消</Button>
            <Button type="submit" loading={saving}>确认处置</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Readiness({ report }: { report: ReadinessReport }) {
  return (
    <div className="readiness">
      <div className="readiness-title">
        <StatusBadge status={report.checkoutAvailable ? "ready" : "not_ready"} />
        <strong>{report.checkoutAvailable ? "结账链路就绪" : "结账链路尚未就绪"}</strong>
      </div>
      <div className="readiness-list">
        {report.checks.map((check) => (
          <div key={check.key}>
            <StatusBadge status={check.status} />
            <span>
              <strong>{check.label || check.key}</strong>
              <small>{check.error?.code || check.action || (check.lastSucceededAt ? `最近检查通过于 ${formatDate(check.lastSucceededAt)}` : "暂无成功记录")}</small>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProviderCheck({ label, value }: { label: string; value: boolean | null }) {
  return (
    <div>
      <StatusBadge status={value === true ? "ready" : value === false ? "not_ready" : "stale"} />
      <span>
        <strong>{label}</strong>
        <small>{value === null ? "未提供签名样本" : value ? "通过" : "未通过"}</small>
      </span>
    </div>
  );
}
