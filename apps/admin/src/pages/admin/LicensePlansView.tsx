import { useEffect, useState, type FormEvent } from "react";
import { Archive, FileClock, Layers3, Pencil, Plus, RefreshCw } from "lucide-react";
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
import { useI18n } from "../../lib/i18n";

const emptyForm = {
  productId: "", name: "", licenseModel: "perpetual" as LicenseModel, credentialMode: "opaque" as CredentialMode,
  maxActivations: "1", features: "", updateWindowSeconds: "", defaultTermSeconds: "",
  signedTokenTtlSeconds: "2592000", paymentGraceSeconds: "",
};

export const MIN_SIGNED_TOKEN_TTL_SECONDS = 1;

export function LicensePlansView({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const [plans, setPlans] = useState<LicensePlan[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState(emptyForm);
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

  function openEditModal() {
    if (!selected) return;
    setEditForm({
      productId: selected.productId,
      name: selected.name,
      licenseModel: selected.licenseModel,
      credentialMode: selected.credentialMode,
      maxActivations: String(selected.maxActivations),
      features: selected.features.join(", "),
      updateWindowSeconds: selected.updateWindowSeconds !== null && selected.updateWindowSeconds !== undefined ? String(selected.updateWindowSeconds) : "",
      defaultTermSeconds: selected.defaultTermSeconds !== null && selected.defaultTermSeconds !== undefined ? String(selected.defaultTermSeconds) : "",
      signedTokenTtlSeconds: String(selected.signedTokenTtlSeconds || 2592000),
      paymentGraceSeconds: selected.paymentGraceSeconds !== undefined && selected.paymentGraceSeconds !== null ? String(selected.paymentGraceSeconds) : "",
    });
    setEditModalOpen(true);
  }

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

  async function updatePlan(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.licensePlans.update(selected.id, {
        name: editForm.name.trim(),
        licenseModel: editForm.licenseModel,
        credentialMode: editForm.credentialMode,
        maxActivations: Number(editForm.maxActivations),
        features: editForm.features.split(",").map((item) => item.trim()).filter(Boolean),
        updateWindowSeconds: editForm.licenseModel === "perpetual"
          ? (editForm.updateWindowSeconds ? Number(editForm.updateWindowSeconds) : null)
          : null,
        defaultTermSeconds: editForm.licenseModel === "fixed_term"
          ? Number(editForm.defaultTermSeconds)
          : null,
        signedTokenTtlSeconds: editForm.credentialMode === "signed"
          ? Number(editForm.signedTokenTtlSeconds)
          : 0,
        paymentGraceSeconds: editForm.licenseModel === "subscription" && editForm.paymentGraceSeconds !== ""
          ? Number(editForm.paymentGraceSeconds)
          : 0,
      });
      setEditModalOpen(false);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
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

  const modelLabel = (model: LicenseModel) => {
    if (model === "perpetual") return t.licensePlans.modelPerpetual;
    if (model === "fixed_term") return t.licensePlans.modelFixedTerm;
    return t.licensePlans.modelSubscription;
  };

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.licensePlans.eyebrow}
        title={t.licensePlans.title}
        description={t.licensePlans.description}
        action={
          <div className="button-row">
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              <RefreshCw className="size-4" />{t.common.refresh}
            </Button>
            {canWrite ? (
              <Button onClick={() => setModalOpen(true)}>
                <Plus className="size-4" />{t.licensePlans.newPlan}
              </Button>
            ) : null}
          </div>
        }
      />
      <ErrorPanel error={error} onClose={() => setError(null)} />
      {loading && plans.length === 0 ? <LoadingState /> : plans.length === 0 ? (
        <EmptyState
          title={t.licensePlans.emptyTitle}
          description={t.licensePlans.emptyDesc}
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
                    {modelLabel(plan.licenseModel)} · {t.licensePlans.revision(plan.revision)}
                  </small>
                </div>
                <StatusBadge status={plan.status} label={plan.status === "active" ? t.common.statusActive : t.common.statusArchived} />
              </button>
            ))}
          </aside>
          {selected ? (
            <div className="detail-stack">
              <Card>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">{t.licensePlans.detailEyebrow} · {t.licensePlans.revision(selected.revision)}</p>
                    <h2>{selected.name}</h2>
                    <p>{products.find((product) => product.id === selected.productId)?.name || selected.productId}</p>
                  </div>
                  <StatusBadge status={selected.status} label={selected.status === "active" ? t.common.statusActive : t.common.statusArchived} />
                </div>
                <div className="metric-grid compact">
                  <div>
                    <span>{t.licensePlans.fieldModel}</span>
                    <strong>{modelLabel(selected.licenseModel)}</strong>
                  </div>
                  <div>
                    <span>{t.licensePlans.fieldCredentialMode}</span>
                    <strong>{selected.credentialMode === "signed" ? t.licensePlans.credentialSigned : t.licensePlans.credentialOpaque}</strong>
                  </div>
                  <div>
                    <span>{t.licensePlans.maxActivationsLabel}</span>
                    <strong>{t.licensePlans.devicesCount(selected.maxActivations)}</strong>
                  </div>
                  <div>
                    <span>{t.licensePlans.graceSecondsLabel}</span>
                    <strong>{formatDurationSeconds(selected.paymentGraceSeconds)}</strong>
                  </div>
                  <div>
                    <span>{t.licensePlans.updateWindowLabel}</span>
                    <strong>{selected.updateWindowSeconds === null ? t.licensePlans.updateWindowForever : formatDurationSeconds(selected.updateWindowSeconds)}</strong>
                  </div>
                  <div>
                    <span>{t.licensePlans.tokenTtlLabel}</span>
                    <strong>{formatDurationSeconds(selected.signedTokenTtlSeconds)}</strong>
                  </div>
                </div>
                <div className="tag-list">
                  {selected.features.length ? selected.features.map((feature) => <span key={feature}>{feature}</span>) : <span>{t.licensePlans.noFeatures}</span>}
                </div>
                <Notice>
                  <strong>{t.licensePlans.revisionNoticeTitle}</strong>
                  <p>{t.licensePlans.revisionNoticeDesc}</p>
                </Notice>
                {canWrite && selected.status === "active" ? (
                  <div className="button-row wrap">
                    <Button variant="secondary" onClick={openEditModal}>
                      <Pencil className="size-4" />{t.licensePlans.btnEditPlan}
                    </Button>
                    <Button variant="danger" loading={saving} onClick={() => setArchiveConfirmOpen(true)}>
                      <Archive className="size-4" />{t.licensePlans.btnArchivePlan}
                    </Button>
                  </div>
                ) : null}
              </Card>
              <Card>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">{t.licensePlans.rulesEyebrow}</p>
                    <h2>{t.licensePlans.rulesTitle}</h2>
                  </div>
                  <FileClock className="size-5" />
                </div>
                <PlanExplanation plan={selected} />
              </Card>
            </div>
          ) : null}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={t.licensePlans.modalCreateTitle} description={t.licensePlans.modalCreateDesc} wide>
        <form className="form-stack" onSubmit={create}>
          <div className="form-grid">
            <Field label={t.licensePlans.fieldSelectProduct}>
              <Select value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })} required>
                <option value="" disabled>{t.licensePlans.fieldSelectProductDefault}</option>
                {products.filter((item) => item.status === "active").map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </Select>
            </Field>
            <Field label={t.licensePlans.fieldName}>
              <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t.licensePlans.fieldNamePlaceholder} required />
            </Field>
          </div>
          <div className="form-grid">
            <Field label={t.licensePlans.fieldModel}>
              <Select value={form.licenseModel} onChange={(event) => setForm({ ...form, licenseModel: event.target.value as LicenseModel })}>
                <option value="perpetual">{t.licensePlans.modelPerpetual}</option>
                <option value="fixed_term">{t.licensePlans.modelFixedTerm}</option>
                <option value="subscription">{t.licensePlans.modelSubscription}</option>
              </Select>
            </Field>
            <Field label={t.licensePlans.fieldCredentialMode}>
              <Select value={form.credentialMode} onChange={(event) => setForm({ ...form, credentialMode: event.target.value as CredentialMode })}>
                <option value="opaque">{t.licensePlans.credentialOpaque}</option>
                <option value="signed">{t.licensePlans.credentialSigned}</option>
              </Select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label={t.licensePlans.fieldMaxActivations}>
              <Input type="number" min="1" value={form.maxActivations} onChange={(event) => setForm({ ...form, maxActivations: event.target.value })} required />
            </Field>
            <Field label={t.licensePlans.fieldFeatures} hint={t.licensePlans.fieldFeaturesHint}>
              <Input value={form.features} onChange={(event) => setForm({ ...form, features: event.target.value })} placeholder="pro_export,batch" />
            </Field>
          </div>
          {form.licenseModel === "perpetual" ? (
            <Field label={t.licensePlans.fieldUpdateWindow} hint={t.licensePlans.fieldUpdateWindowHint}>
              <Input type="number" min="1" value={form.updateWindowSeconds} onChange={(event) => setForm({ ...form, updateWindowSeconds: event.target.value })} placeholder={t.licensePlans.placeholderUpdateWindow} />
            </Field>
          ) : null}
          {form.licenseModel === "fixed_term" ? (
            <Field label={t.licensePlans.fieldDefaultTerm} hint={t.licensePlans.fieldDefaultTermHint}>
              <Input type="number" min="1" value={form.defaultTermSeconds} onChange={(event) => setForm({ ...form, defaultTermSeconds: event.target.value })} placeholder={t.licensePlans.placeholderTermSeconds} required />
            </Field>
          ) : null}
          {form.licenseModel === "subscription" ? (
            <Field label={t.licensePlans.fieldPaymentGrace} hint={t.licensePlans.fieldPaymentGraceHint}>
              <Input type="number" min="0" value={form.paymentGraceSeconds} onChange={(event) => setForm({ ...form, paymentGraceSeconds: event.target.value })} placeholder={t.licensePlans.placeholderGraceSeconds} />
            </Field>
          ) : null}
          {form.credentialMode === "signed" ? (
            <Field label={t.licensePlans.fieldTokenTtl} hint={t.licensePlans.fieldTokenTtlHint}>
              <Input type="number" min={MIN_SIGNED_TOKEN_TTL_SECONDS} value={form.signedTokenTtlSeconds} onChange={(event) => setForm({ ...form, signedTokenTtlSeconds: event.target.value })} required />
            </Field>
          ) : null}
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>{t.common.cancel}</Button>
            <Button loading={saving} type="submit">{t.licensePlans.btnCreatePlan}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title={t.licensePlans.modalEditTitle((selected?.revision ?? 1) + 1)} description={t.licensePlans.modalEditDesc} wide>
        <form className="form-stack" onSubmit={updatePlan}>
          <div className="form-grid">
            <Field label={t.licensePlans.fieldName}>
              <Input value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} required />
            </Field>
            <Field label={t.licensePlans.fieldModel}>
              <Select value={editForm.licenseModel} onChange={(event) => setEditForm({ ...editForm, licenseModel: event.target.value as LicenseModel })}>
                <option value="perpetual">{t.licensePlans.modelPerpetual}</option>
                <option value="fixed_term">{t.licensePlans.modelFixedTerm}</option>
                <option value="subscription">{t.licensePlans.modelSubscription}</option>
              </Select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label={t.licensePlans.fieldCredentialMode}>
              <Select value={editForm.credentialMode} onChange={(event) => setEditForm({ ...editForm, credentialMode: event.target.value as CredentialMode })}>
                <option value="opaque">{t.licensePlans.credentialOpaque}</option>
                <option value="signed">{t.licensePlans.credentialSigned}</option>
              </Select>
            </Field>
            <Field label={t.licensePlans.fieldMaxActivations}>
              <Input type="number" min="1" value={editForm.maxActivations} onChange={(event) => setEditForm({ ...editForm, maxActivations: event.target.value })} required />
            </Field>
          </div>
          <Field label={t.licensePlans.fieldFeatures} hint={t.licensePlans.fieldFeaturesHint}>
            <Input value={editForm.features} onChange={(event) => setEditForm({ ...editForm, features: event.target.value })} placeholder="pro_export,batch" />
          </Field>
          {editForm.licenseModel === "perpetual" ? (
            <Field label={t.licensePlans.fieldUpdateWindow} hint={t.licensePlans.fieldUpdateWindowHint}>
              <Input type="number" min="1" value={editForm.updateWindowSeconds} onChange={(event) => setEditForm({ ...editForm, updateWindowSeconds: event.target.value })} placeholder={t.licensePlans.placeholderUpdateWindow} />
            </Field>
          ) : null}
          {editForm.licenseModel === "fixed_term" ? (
            <Field label={t.licensePlans.fieldDefaultTerm} hint={t.licensePlans.fieldDefaultTermHint}>
              <Input type="number" min="1" value={editForm.defaultTermSeconds} onChange={(event) => setEditForm({ ...editForm, defaultTermSeconds: event.target.value })} placeholder={t.licensePlans.placeholderTermSeconds} required />
            </Field>
          ) : null}
          {editForm.licenseModel === "subscription" ? (
            <Field label={t.licensePlans.fieldPaymentGrace} hint={t.licensePlans.fieldPaymentGraceHint}>
              <Input type="number" min="0" value={editForm.paymentGraceSeconds} onChange={(event) => setEditForm({ ...editForm, paymentGraceSeconds: event.target.value })} placeholder={t.licensePlans.placeholderGraceSeconds} />
            </Field>
          ) : null}
          {editForm.credentialMode === "signed" ? (
            <Field label={t.licensePlans.fieldTokenTtl} hint={t.licensePlans.fieldTokenTtlHint}>
              <Input type="number" min={MIN_SIGNED_TOKEN_TTL_SECONDS} value={editForm.signedTokenTtlSeconds} onChange={(event) => setEditForm({ ...editForm, signedTokenTtlSeconds: event.target.value })} required />
            </Field>
          ) : null}
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setEditModalOpen(false)}>{t.common.cancel}</Button>
            <Button loading={saving} type="submit">{t.licensePlans.btnSaveNewRevision}</Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={archiveConfirmOpen}
        title={t.licensePlans.archiveConfirmTitle}
        description={t.licensePlans.archiveConfirmDesc(selected?.name || "")}
        confirmLabel={t.licensePlans.archiveConfirmBtn}
        variant="danger"
        loading={saving}
        onConfirm={handleConfirmArchive}
        onClose={() => setArchiveConfirmOpen(false)}
      />
    </div>
  );
}

function PlanExplanation({ plan }: { plan: LicensePlan }) {
  const { t } = useI18n();
  if (plan.licenseModel === "perpetual") {
    return (
      <p className="explanation">
        {plan.updateWindowSeconds === null
          ? t.licensePlans.rulesExplanationPerpetualForever
          : t.licensePlans.rulesExplanationPerpetualWindow(formatDurationSeconds(plan.updateWindowSeconds))}
      </p>
    );
  }
  if (plan.licenseModel === "fixed_term") {
    return (
      <p className="explanation">
        {t.licensePlans.rulesExplanationFixedTerm(formatDurationSeconds(plan.defaultTermSeconds))}
      </p>
    );
  }
  return (
    <p className="explanation">
      {t.licensePlans.rulesExplanationSubscription}
    </p>
  );
}
