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
      await openVerificationCheckout(offer.id, async () => {
        const response = await api.admin.billing.offers.verificationConfig(offer.id);
        expiresAt = response.data.expiresAt;
        return response;
      });
      setVerificationPending({ offerId: offer.id, expiresAt });
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function resolveAdjustment(adjustment: BillingAdjustment) {
    const action = window.prompt("输入处理动作：no_action / keep_suspended / reinstate / revoke / security_reset", "keep_suspended");
    if (!action || !["no_action", "keep_suspended", "reinstate", "revoke", "security_reset"].includes(action)) return;
    const reason = window.prompt("输入处理原因（必填）。", "");
    if (!reason?.trim()) return;
    setSaving(true); setError(null);
    try { await api.admin.billing.adjustments.resolve(adjustment.id, { action: action as "no_action" | "keep_suspended" | "reinstate" | "revoke" | "security_reset", reason: reason.trim() }); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Paddle 首发闭环" title="支付连接与 Offer" description="Provider、Offer、Subscription 和 Adjustment 分别显示。active Offer 仍需实时 Checkout Readiness 才能公开收款。" action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>} />
      <ErrorPanel error={error} />
      <div className="tabs" role="tablist">{(["providers", "offers", "subscriptions", "adjustments"] as Tab[]).map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{item === "providers" ? "Billing Provider" : item === "offers" ? "Offer & Readiness" : item === "subscriptions" ? "Subscription" : "Adjustment"}</button>)}</div>
      {loading && providers.length + offers.length + subscriptions.length + adjustments.length === 0 ? <LoadingState /> : null}

      {tab === "providers" ? <Card>
        <div className="card-header"><div><p className="eyebrow">Connection identity</p><h2>Paddle Provider</h2><p>Sandbox 与 Live 是两条独立连接；provider 和 environment 创建后不可修改。</p></div>{canManage ? <Button onClick={() => setProviderModal(true)}><Plus className="size-4" />连接 Paddle</Button> : null}</div>
        {providers.length === 0 ? <EmptyState title="还没有 Billing Provider" description="基础购买闭环需要 Client-side Token 与 Webhook Secret；API Key 只为可选服务端能力。" /> : <div className="card-grid">{providers.map((provider) => <article className="entity-card" key={provider.id}><header><div><strong>Paddle {provider.environment}</strong><span>{provider.id}</span></div><StatusBadge status={provider.status} /></header><div className="readiness-summary"><span>{provider.clientSideTokenConfigured ?? Boolean(provider.clientSideToken) ? <CheckCircle2 /> : <AlertTriangle />}Client-side Token</span><span>{provider.webhookSecretConfigured ? <CheckCircle2 /> : <AlertTriangle />}Webhook Secret</span><span>{provider.apiKeyConfigured ? <CheckCircle2 /> : <ShieldQuestion />}API Key（可选）</span></div>{provider.readiness ? <Readiness report={provider.readiness} /> : null}{canManage ? <Button variant="secondary" loading={saving} onClick={() => void testProvider(provider)}>运行配置检查</Button> : null}</article>)}</div>}
      </Card> : null}

      {tab === "offers" ? <Card>
        <div className="card-header"><div><p className="eyebrow">Price mapping</p><h2>Offer 与收款就绪</h2><p>Offer 默认 draft；服务端检查通过后才能显式激活。</p></div>{canManage ? <Button onClick={() => setOfferModal(true)}><Plus className="size-4" />创建 Offer</Button> : null}</div>
        {verificationPending ? <Notice tone="warning"><strong>真实 Sandbox Checkout 已打开，但闭环尚未完成。</strong><p>Offer {verificationPending.offerId} 的本次验证配置有效至 {formatDate(verificationPending.expiresAt)}。一次性令牌已由共享 Checkout SDK 消费并清除；只有已验签 Webhook 完成履约且 Delivery accepted 后，服务端验证状态才会成为 completed。</p></Notice> : null}
        {offers.length === 0 ? <EmptyState title="还没有 Offer" description="把一个 Paddle Price 映射到 Product 与授权方案。" /> : <div className="stack-list">{offers.map((offer) => {
          const provider = providers.find((item) => item.id === offer.billingProviderId);
          return <div className="offer-row" key={offer.id}><div className="offer-main"><div><strong>{offer.productName || products.find((item) => item.id === offer.productId)?.name || offer.productId}</strong><span>{offer.licensePlanName || plans.find((item) => item.id === offer.licensePlanId)?.name || offer.licensePlanId}</span></div><code>{offer.externalPriceId}</code></div><div className="offer-meta"><Badge>{offer.purchaseType}</Badge><Badge>{provider?.environment || "unknown"}</Badge><StatusBadge status={offer.status} /><StatusBadge status={offer.readiness?.checkoutAvailable ? "ready" : "not_ready"} /></div>{offer.readiness ? <Readiness report={offer.readiness} /> : null}{canManage ? <div className="button-row wrap">{offer.status === "draft" && provider?.environment === "sandbox" ? <Button variant="secondary" loading={saving} onClick={() => void prepareVerification(offer)}><FlaskConical className="size-4" />打开真实 Sandbox 验证</Button> : null}{offer.status === "draft" ? <Button loading={saving} onClick={() => void activateOffer(offer)}>实时检查并激活</Button> : null}</div> : null}</div>;
        })}</div>}
      </Card> : null}

      {tab === "subscriptions" ? <Card><div className="card-header"><div><p className="eyebrow">Billing mirror</p><h2>Subscription</h2><p>支付状态由已验签 Webhook 更新，不在控制台直接修改。</p></div><Badge>{subscriptions.length}</Badge></div>{subscriptions.length === 0 ? <EmptyState title="暂无 Subscription" description="Paddle 订阅购买或免费订阅试用履约后会出现在这里。" /> : <div className="table-wrap"><table><thead><tr><th>外部订阅</th><th>License / Customer</th><th>环境</th><th>状态</th><th>当前周期</th></tr></thead><tbody>{subscriptions.map((item) => <tr key={item.id}><td><strong>{item.externalSubscriptionId}</strong><small>{item.id}</small></td><td><span>{item.licenseId}</span><small>{item.customerId}</small></td><td>{item.environment}</td><td><StatusBadge status={item.status} /></td><td>{formatDate(item.currentPeriodEnd)}{item.cancelAtPeriodEnd ? <small>周期末取消</small> : null}</td></tr>)}</tbody></table></div>}</Card> : null}

      {tab === "adjustments" ? <Card><div className="card-header"><div><p className="eyebrow">Refund & dispute facts</p><h2>Adjustment</h2><p>保留 provider 的 action + type + status，不归一化为同一种支付失败。</p></div><Badge>{adjustments.length}</Badge></div>{adjustments.length === 0 ? <EmptyState title="暂无 Adjustment" description="退款、credit、拒付与反转事件会持久化到这里。" /> : <div className="table-wrap"><table><thead><tr><th>外部 Adjustment</th><th>原始语义</th><th>金额</th><th>License 影响</th><th>人工状态</th><th></th></tr></thead><tbody>{adjustments.map((item) => <tr key={item.id}><td><strong>{item.externalAdjustmentId}</strong><small>{item.provider}</small></td><td>{item.action} + {item.type} + {item.status}</td><td>{item.amount || "—"} {item.currencyCode || ""}</td><td>{item.automaticEffect || "无自动动作"}<small>{item.licenseId || "未关联"}</small></td><td><StatusBadge status={item.reviewStatus} /></td><td>{canManage && item.reviewStatus === "open" ? <Button variant="secondary" loading={saving} onClick={() => void resolveAdjustment(item)}>人工处置</Button> : null}</td></tr>)}</tbody></table></div>}</Card> : null}

      <Modal open={providerModal} onClose={() => setProviderModal(false)} title="连接 Paddle Provider" description="Client-side Token 可公开；Webhook Secret 与 API Key 只发送到服务端并加密保存。">
        <form className="form-stack" onSubmit={createProvider}><Field label="环境"><Select value={providerForm.environment} onChange={(event) => setProviderForm({ ...providerForm, environment: event.target.value as BillingEnvironment })}><option value="sandbox">Sandbox</option><option value="live">Live</option></Select></Field><Field label="Client-side Token"><Input value={providerForm.clientSideToken} onChange={(event) => setProviderForm({ ...providerForm, clientSideToken: event.target.value })} autoComplete="off" required /></Field><Field label="Webhook Secret"><Input type="password" value={providerForm.webhookSecret} onChange={(event) => setProviderForm({ ...providerForm, webhookSecret: event.target.value })} autoComplete="new-password" required /></Field><Field label="Paddle API Key（可选）" hint="仅用于 Customer 读穿、对账或托管客户门户"><Input type="password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} autoComplete="new-password" /></Field><div className="form-actions"><Button variant="secondary" type="button" onClick={() => setProviderModal(false)}>取消</Button><Button type="submit" loading={saving}>创建连接</Button></div></form>
      </Modal>

      <Modal open={offerModal} onClose={() => setOfferModal(false)} title="创建 Offer Mapping" description="创建后固定为 draft；只允许一个 Price、数量 1 的普通 Checkout。">
        <form className="form-stack" onSubmit={createOffer}><Field label="Billing Provider"><Select value={offerForm.billingProviderId} onChange={(event) => setOfferForm({ ...offerForm, billingProviderId: event.target.value })} required>{providers.map((item) => <option key={item.id} value={item.id}>Paddle {item.environment}</option>)}</Select></Field><Field label="Paddle Price ID"><Input value={offerForm.externalPriceId} onChange={(event) => setOfferForm({ ...offerForm, externalPriceId: event.target.value })} placeholder="pri_…" required /></Field><div className="form-grid"><Field label="Product"><Select value={offerForm.productId} onChange={(event) => setOfferForm({ ...offerForm, productId: event.target.value })} required>{products.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name} · {item.billingEnvironment || "no billing"}</option>)}</Select></Field><Field label="授权方案"><Select value={offerForm.licensePlanId} onChange={(event) => { const plan = plans.find((item) => item.id === event.target.value); setOfferForm({ ...offerForm, licensePlanId: event.target.value, purchaseType: plan?.licenseModel === "subscription" ? "subscription" : "one_time" }) }} required>{plans.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name} · {item.licenseModel}</option>)}</Select></Field></div><Field label="购买类型"><Select value={offerForm.purchaseType} onChange={(event) => setOfferForm({ ...offerForm, purchaseType: event.target.value as "one_time" | "subscription" })}><option value="one_time">one_time</option><option value="subscription">subscription</option></Select></Field><div className="form-actions"><Button variant="secondary" type="button" onClick={() => setOfferModal(false)}>取消</Button><Button type="submit" loading={saving}>创建 draft Offer</Button></div></form>
      </Modal>

      <Modal open={Boolean(providerTest)} onClose={() => setProviderTest(null)} title={providerTest ? `Paddle ${providerTest.environment} 配置检查` : "Provider 检查"} description="该测试只验证 Provider 配置能力，不创建 License，也不等同于完整 Checkout Readiness。">
        {providerTest ? <div className="readiness-list"><ProviderCheck label="Client-side Token 环境有效" value={providerTest.clientSideTokenValid} /><ProviderCheck label="Webhook Secret 可解密" value={providerTest.webhookSecretDecryptable} /><ProviderCheck label="签名样本已验证" value={providerTest.signatureSampleVerified} /><ProviderCheck label="API Key 已配置（可选）" value={providerTest.apiKeyConfigured} /></div> : null}
      </Modal>
    </div>
  );
}

function Readiness({ report }: { report: ReadinessReport }) {
  return <div className="readiness"><div className="readiness-title"><StatusBadge status={report.checkoutAvailable ? "ready" : "not_ready"} /><strong>{report.checkoutAvailable ? "Checkout available" : "Checkout unavailable"}</strong></div><div className="readiness-list">{report.checks.map((check) => <div key={check.key}><StatusBadge status={check.status} /><span><strong>{check.label || check.key}</strong><small>{check.error?.code || check.action || (check.lastSucceededAt ? `最近成功 ${formatDate(check.lastSucceededAt)}` : "暂无成功证据")}</small></span></div>)}</div></div>;
}

function ProviderCheck({ label, value }: { label: string; value: boolean | null }) {
  return <div><StatusBadge status={value === true ? "ready" : value === false ? "not_ready" : "stale"} /><span><strong>{label}</strong><small>{value === null ? "未提供签名样本" : value ? "通过" : "未通过"}</small></span></div>;
}
