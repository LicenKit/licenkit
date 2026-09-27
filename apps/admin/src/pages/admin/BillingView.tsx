import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, CircleDollarSign, FlaskConical, Plus, RefreshCw, ShieldQuestion } from "lucide-react";
import { api, type BillingAdjustment, type BillingEnvironment, type BillingOffer, type BillingProvider, type BillingSubscription, type Instance, type LicensePlan, type Product, type ProviderTestResult, type ReadinessReport } from "../../lib/api-client";
import { openVerificationCheckout } from "../../lib/verification-checkout";
import { Badge, Button, Card, CopyValue, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, Select, StatusBadge } from "../../components/ui";
import { useI18n } from "../../lib/i18n";
import { buildPaddleWebhookUrl } from "../../lib/billing-webhook";

type Tab = "providers" | "offers" | "subscriptions" | "adjustments";

export function BillingView({ canManage, instance }: { canManage: boolean; instance: Pick<Instance, "id" | "adminApiUrl"> }) {
  const { t, formatDate } = useI18n();
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
  const webhookUrl = buildPaddleWebhookUrl(instance.adminApiUrl, instance.id, providerForm.environment);

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
      await api.admin.billing.providers.create({ provider: "paddle", environment: providerForm.environment, clientSideToken: providerForm.clientSideToken.trim(), webhookSecret: providerForm.webhookSecret, apiKey: providerForm.apiKey || undefined });
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
    providers: t.billing.tabProviders,
    offers: t.billing.tabOffers,
    subscriptions: t.billing.tabSubscriptions,
    adjustments: t.billing.tabAdjustments,
  };

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.billing.eyebrow}
        title={t.billing.title}
        description={t.billing.description}
        action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />{t.common.refresh}</Button>}
      />
      <ErrorPanel error={error} onClose={() => setError(null)} />
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
            <p className="eyebrow">{t.billing.tabProviders}</p>
            <h2>{t.billing.providerCardTitle("Paddle", "")}</h2>
            <p>{t.billing.modalProviderDesc}</p>
          </div>
          {canManage ? <Button onClick={() => setProviderModal(true)}><Plus className="size-4" />{t.billing.newProvider}</Button> : null}
        </div>
        {providers.length === 0 ? <EmptyState title={t.billing.providersEmptyTitle} description={t.billing.providersEmptyDesc} /> : <div className="card-grid">{providers.map((provider) => <article className="entity-card" key={provider.id}><header><div><strong>Paddle {provider.environment === "sandbox" ? t.billing.providerEnvSandbox : t.billing.providerEnvLive}</strong><span>{provider.id}</span></div><StatusBadge status={provider.status} /></header><div className="readiness-summary"><span>{provider.clientSideTokenConfigured ?? Boolean(provider.clientSideToken) ? <CheckCircle2 /> : <AlertTriangle />}Client-side Token</span><span>{provider.webhookSecretConfigured ? <CheckCircle2 /> : <AlertTriangle />}Webhook Secret</span><span>{provider.apiKeyConfigured ? <CheckCircle2 /> : <ShieldQuestion />}API Key</span></div>{provider.readiness ? <Readiness report={provider.readiness} /> : null}{canManage ? <Button variant="secondary" loading={saving} onClick={() => void testProvider(provider)}>{t.billing.btnTestProvider}</Button> : null}</article>)}</div>}
      </Card> : null}

      {tab === "offers" ? <Card>
        <div className="card-header">
          <div>
            <p className="eyebrow">{t.billing.tabOffers}</p>
            <h2>{t.billing.tabOffers}</h2>
            <p>{t.billing.modalOfferDesc}</p>
          </div>
          {canManage ? <Button onClick={() => setOfferModal(true)}><Plus className="size-4" />{t.billing.newOffer}</Button> : null}
        </div>
        {verificationPending ? (
          <Notice tone="warning">
            <strong>Paddle Sandbox Checkout</strong>
            <p>Expires: {formatDate(verificationPending.expiresAt)} ({verificationPending.offerId})</p>
          </Notice>
        ) : null}
        {offers.length === 0 ? <EmptyState title={t.billing.offersEmptyTitle} description={t.billing.offersEmptyDesc} /> : <div className="stack-list">{offers.map((offer) => {
          const provider = providers.find((item) => item.id === offer.billingProviderId);
          return <div className="offer-row" key={offer.id}><div className="offer-main"><div><strong>{offer.productName || products.find((item) => item.id === offer.productId)?.name || offer.productId}</strong><span>{offer.licensePlanName || plans.find((item) => item.id === offer.licensePlanId)?.name || offer.licensePlanId}</span></div><code>{offer.externalPriceId}</code></div><div className="offer-meta"><Badge>{offer.purchaseType === "subscription" ? t.billing.offerTypeSubscription : t.billing.offerTypeOneTime}</Badge><Badge>{provider?.environment || "—"}</Badge><StatusBadge status={offer.status} /></div>{offer.readiness ? <Readiness report={offer.readiness} /> : null}{canManage ? <div className="button-row wrap">{offer.status === "draft" && provider?.environment === "sandbox" ? <Button variant="secondary" loading={saving} onClick={() => void prepareVerification(offer)}><FlaskConical className="size-4" />{t.billing.btnActivateOffer}</Button> : null}{offer.status === "draft" ? <Button loading={saving} onClick={() => void activateOffer(offer)}>{t.billing.btnVerifyReadiness}</Button> : null}</div> : null}</div>;
        })}</div>}
      </Card> : null}

      {tab === "subscriptions" ? <Card><div className="card-header"><div><p className="eyebrow">{t.billing.tabSubscriptions}</p><h2>{t.billing.tabSubscriptions}</h2><p>{t.billing.subscriptionsEmptyDesc}</p></div><Badge>{subscriptions.length}</Badge></div>{subscriptions.length === 0 ? <EmptyState title={t.billing.subscriptionsEmptyTitle} description={t.billing.subscriptionsEmptyDesc} /> : <div className="table-wrap"><table><thead><tr><th>{t.billing.tableColSubId}</th><th>{t.billing.tableColSubLicenseCustomer}</th><th>{t.billing.fieldEnv}</th><th>{t.common.status}</th><th>{t.billing.tableColSubPeriodEnd}</th></tr></thead><tbody>{subscriptions.map((item) => <tr key={item.id}><td><strong>{item.externalSubscriptionId}</strong><small>{item.id}</small></td><td><span>{item.licenseId}</span><small>{item.customerId}</small></td><td>{item.environment}</td><td><StatusBadge status={item.status} /></td><td>{formatDate(item.currentPeriodEnd)}{item.cancelAtPeriodEnd ? <small>{t.billing.subCancelAtPeriodEnd}</small> : null}</td></tr>)}</tbody></table></div>}</Card> : null}

      {tab === "adjustments" ? <Card><div className="card-header"><div><p className="eyebrow">{t.billing.tabAdjustments}</p><h2>{t.billing.tabAdjustments}</h2><p>{t.billing.adjustmentsEmptyDesc}</p></div><Badge>{adjustments.length}</Badge></div>{adjustments.length === 0 ? <EmptyState title={t.billing.adjustmentsEmptyTitle} description={t.billing.adjustmentsEmptyDesc} /> : <div className="table-wrap"><table><thead><tr><th>{t.billing.tableColAdjExternalId}</th><th>{t.billing.tableColAdjGatewayStatus}</th><th>{t.billing.tableColAdjAmount}</th><th>{t.billing.tableColAdjSystemEffect}</th><th>{t.billing.tableColAdjReviewStatus}</th><th>{t.common.actions}</th></tr></thead><tbody>{adjustments.map((item) => <tr key={item.id}><td><strong>{item.externalAdjustmentId}</strong><small>{item.provider}</small></td><td>{item.action} · {item.type} · {item.status}</td><td>{item.amount || "—"} {item.currencyCode || ""}</td><td>{item.automaticEffect || t.billing.adjNoAutomaticEffect}<small>{item.licenseId || t.billing.adjUnlinkedLicense}</small></td><td><StatusBadge status={item.reviewStatus} /></td><td>{canManage && item.reviewStatus === "open" ? <Button variant="secondary" loading={saving} onClick={() => { setResolvingAdjustment(item); setAdjustmentAction("keep_suspended"); setAdjustmentReason(""); }}>{t.billing.modalResolveTitle}</Button> : null}</td></tr>)}</tbody></table></div>}</Card> : null}

      <Modal open={providerModal} onClose={() => setProviderModal(false)} title={t.billing.modalProviderTitle} description={t.billing.modalProviderDesc}>
        <form className="form-stack" onSubmit={createProvider}><Field label={t.billing.fieldEnv}><Select value={providerForm.environment} onChange={(event) => setProviderForm({ ...providerForm, environment: event.target.value as BillingEnvironment })}><option value="sandbox">{t.billing.providerEnvSandbox}</option><option value="live">{t.billing.providerEnvLive}</option></Select></Field><Field label={t.billing.fieldClientToken} hint={t.billing.fieldClientTokenHint}><Input value={providerForm.clientSideToken} onChange={(event) => setProviderForm({ ...providerForm, clientSideToken: event.target.value })} autoComplete="off" required /></Field><Field label={t.billing.fieldWebhookSecret} hint={t.billing.fieldWebhookSecretHint}><Input type="password" value={providerForm.webhookSecret} onChange={(event) => setProviderForm({ ...providerForm, webhookSecret: event.target.value })} autoComplete="new-password" required /></Field><div className="webhook-endpoint"><span className="field-label">{t.billing.fieldWebhookUrl}</span><div><code>{webhookUrl}</code><CopyValue value={webhookUrl} /></div><span className="field-hint">{t.billing.fieldWebhookUrlHint}</span></div><Field label={t.billing.fieldApiKey} hint={t.billing.fieldApiKeyHint}><Input type="password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} autoComplete="new-password" /></Field><div className="form-actions"><Button variant="secondary" type="button" onClick={() => setProviderModal(false)}>{t.common.cancel}</Button><Button type="submit" loading={saving}>{t.billing.btnCreateProvider}</Button></div></form>
      </Modal>

      <Modal open={offerModal} onClose={() => setOfferModal(false)} title={t.billing.modalOfferTitle} description={t.billing.modalOfferDesc}>
        <form className="form-stack" onSubmit={createOffer}><Field label={t.billing.fieldSelectProvider}><Select value={offerForm.billingProviderId} onChange={(event) => setOfferForm({ ...offerForm, billingProviderId: event.target.value })} required>{providers.map((item) => <option key={item.id} value={item.id}>Paddle {item.environment === "sandbox" ? "Sandbox" : "Live"} ({item.id})</option>)}</Select></Field><Field label={t.billing.fieldPriceId} hint={t.billing.fieldPriceIdHint}><Input value={offerForm.externalPriceId} onChange={(event) => setOfferForm({ ...offerForm, externalPriceId: event.target.value })} placeholder="pri_…" required /></Field><div className="form-grid"><Field label={t.billing.fieldSelectProduct}><Select value={offerForm.productId} onChange={(event) => setOfferForm({ ...offerForm, productId: event.target.value })} required>{products.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label={t.billing.fieldSelectPlan}><Select value={offerForm.licensePlanId} onChange={(event) => { const plan = plans.find((item) => item.id === event.target.value); setOfferForm({ ...offerForm, licensePlanId: event.target.value, purchaseType: plan?.licenseModel === "subscription" ? "subscription" : "one_time" }) }} required>{plans.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name} ({item.licenseModel === "subscription" ? t.billing.offerTypeSubscription : t.billing.offerTypeOneTime})</option>)}</Select></Field></div><Field label={t.billing.fieldPurchaseType}><Select value={offerForm.purchaseType} onChange={(event) => setOfferForm({ ...offerForm, purchaseType: event.target.value as "one_time" | "subscription" })}><option value="one_time">{t.billing.offerTypeOneTime}</option><option value="subscription">{t.billing.offerTypeSubscription}</option></Select></Field><div className="form-actions"><Button variant="secondary" type="button" onClick={() => setOfferModal(false)}>{t.common.cancel}</Button><Button type="submit" loading={saving}>{t.billing.btnCreateOffer}</Button></div></form>
      </Modal>

      <Modal open={Boolean(providerTest)} onClose={() => setProviderTest(null)} title={providerTest ? `Paddle ${providerTest.environment === "sandbox" ? "Sandbox" : "Live"}` : ""} description={t.billing.modalProviderDesc}>
        {providerTest ? <div className="readiness-list"><ProviderCheck label="Client-side Token" value={providerTest.clientSideTokenValid} /><ProviderCheck label="Webhook Secret" value={providerTest.webhookSecretDecryptable} /><ProviderCheck label="Webhook Signature" value={providerTest.signatureSampleVerified} /><ProviderCheck label="API Key" value={providerTest.apiKeyConfigured} /></div> : null}
      </Modal>

      <Modal
        open={Boolean(resolvingAdjustment)}
        onClose={() => { setResolvingAdjustment(null); setAdjustmentReason(""); }}
        title={t.billing.modalResolveTitle}
        description={resolvingAdjustment ? `${resolvingAdjustment.externalAdjustmentId} (${resolvingAdjustment.licenseId || "—"})` : ""}
      >
        <form onSubmit={submitResolveAdjustment} className="form-stack">
          <Field label={t.billing.fieldResolutionAction}>
            <Select value={adjustmentAction} onChange={(e) => setAdjustmentAction(e.target.value as any)}>
              <option value="keep_suspended">{t.billing.actionKeepSuspended}</option>
              <option value="reinstate">{t.billing.actionReinstate}</option>
              <option value="revoke">{t.billing.actionRevoke}</option>
              <option value="security_reset">{t.billing.actionSecurityReset}</option>
              <option value="no_action">{t.billing.actionNoAction}</option>
            </Select>
          </Field>
          <Field label={t.billing.fieldReason}>
            <Input
              value={adjustmentReason}
              onChange={(e) => setAdjustmentReason(e.target.value)}
              placeholder="Reason..."
              required
            />
          </Field>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => { setResolvingAdjustment(null); setAdjustmentReason(""); }}>{t.common.cancel}</Button>
            <Button type="submit" loading={saving}>{t.billing.btnResolveSubmit}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Readiness({ report }: { report: ReadinessReport }) {
  const { formatDate } = useI18n();
  return (
    <div className="readiness">
      <div className="readiness-title">
        <StatusBadge status={report.checkoutAvailable ? "ready" : "not_ready"} />
        <strong>{report.checkoutAvailable ? "Checkout Ready" : "Checkout Not Ready"}</strong>
      </div>
      <div className="readiness-list">
        {report.checks.map((check) => (
          <div key={check.key}>
            <StatusBadge status={check.status} />
            <span>
              <strong>{check.label || check.key}</strong>
              <small>{check.error?.code || check.action || (check.lastSucceededAt ? formatDate(check.lastSucceededAt) : "—")}</small>
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
        <small>{value === null ? "—" : value ? "Passed" : "Failed"}</small>
      </span>
    </div>
  );
}
