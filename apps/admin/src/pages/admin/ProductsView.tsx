import { useEffect, useState, type FormEvent } from "react";
import { Archive, Box, CalendarPlus, FlaskConical, KeyRound, PackagePlus, Pencil, Plus, RefreshCw } from "lucide-react";
import { api, type BillingEnvironment, type Instance, type Product, type ProductRelease } from "../../lib/api-client";
import { Badge, Button, Card, ConfirmModal, CopyValue, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, Select, StatusBadge, Textarea } from "../../components/ui";
import { useI18n } from "../../lib/i18n";
import { daysToSeconds, secondsToDays } from "../../lib/duration";

const emptyProduct = { name: "", description: "", billingEnvironment: "" as BillingEnvironment | "", trialEnabled: false, trialDurationDays: "", trialFeatures: "" };
const emptyProductEdit = { name: "", description: "", billingEnvironment: "" as BillingEnvironment | "", trialEnabled: false, trialDurationDays: "", trialFeatures: "" };
const emptyRelease = { version: "", platform: "", description: "", downloadUrl: "", artifactSha256: "", releasedAt: "" };

export function ProductsView({ canWrite, instance }: { canWrite: boolean; instance: Pick<Instance, "adminApiUrl"> }) {
  const { t, formatDate } = useI18n();
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [releases, setReleases] = useState<ProductRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [productModal, setProductModal] = useState(false);
  const [editProductModal, setEditProductModal] = useState(false);
  const [releaseModal, setReleaseModal] = useState(false);
  const [productForm, setProductForm] = useState(emptyProduct);
  const [editProductForm, setEditProductForm] = useState(emptyProductEdit);
  const [releaseForm, setReleaseForm] = useState(emptyRelease);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const selected = products.find((product) => product.id === selectedId) ?? null;
  const swiftConfiguration = selected?.signingKey ? `let configuration = LicenKitConfiguration(
    serverURL: URL(string: "${instance.adminApiUrl}")!,
    productID: "${selected.id}",
    signingPublicKey: "${selected.signingKey.publicKey}"
)` : "";

  async function loadProducts() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.admin.products.list();
      setProducts(result.items);
      setSelectedId((current) => current && result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? null);
    } catch (caught) { setError(caught) } finally { setLoading(false) }
  }

  async function loadReleases(productId: string) {
    try { setReleases((await api.admin.products.releases.list(productId)).items) } catch (caught) { setError(caught) }
  }

  useEffect(() => { void loadProducts() }, []);
  useEffect(() => { if (selectedId) void loadReleases(selectedId); else setReleases([]) }, [selectedId]);

  async function createProduct(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError(null);
    try {
      const created = await api.admin.products.create({
        name: productForm.name.trim(), description: productForm.description.trim() || null,
        billingEnvironment: productForm.billingEnvironment || null,
        trial: { enabled: productForm.trialEnabled, durationSeconds: productForm.trialEnabled ? daysToSeconds(productForm.trialDurationDays) : undefined, features: productForm.trialFeatures.split(",").map((item) => item.trim()).filter(Boolean) },
      });
      setProductModal(false); setProductForm(emptyProduct); await loadProducts(); setSelectedId(created.id);
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  function openEditProduct() {
    if (!selected) return;
    try {
      setEditProductForm({
        name: selected.name,
        description: selected.description ?? "",
        billingEnvironment: selected.billingEnvironment ?? "",
        trialEnabled: selected.trial?.enabled ?? false,
        trialDurationDays: selected.trial?.enabled && selected.trial.durationSeconds !== undefined
          ? secondsToDays(selected.trial.durationSeconds)
          : "",
        trialFeatures: selected.trial?.features.join(",") ?? "",
      });
      setEditProductModal(true);
    } catch (caught) {
      setError(caught);
    }
  }

  async function updateProduct(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      await api.admin.products.update(selected.id, {
        name: editProductForm.name.trim(),
        description: editProductForm.description.trim() || null,
        billingEnvironment: editProductForm.billingEnvironment || null,
        trial: {
          enabled: editProductForm.trialEnabled,
          durationSeconds: editProductForm.trialEnabled ? daysToSeconds(editProductForm.trialDurationDays) : undefined,
          features: editProductForm.trialFeatures.split(",").map((item) => item.trim()).filter(Boolean),
        },
      });
      setEditProductModal(false);
      await loadProducts();
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function createRelease(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      await api.admin.products.releases.create(selected.id, {
        version: releaseForm.version.trim(), platform: releaseForm.platform.trim(), description: releaseForm.description.trim() || null,
        downloadUrl: releaseForm.downloadUrl.trim() || null, artifactSha256: releaseForm.artifactSha256.trim().toLowerCase(),
        releasedAt: new Date(releaseForm.releasedAt).toISOString(),
      });
      setReleaseModal(false); setReleaseForm(emptyRelease); await loadReleases(selected.id);
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  async function handleConfirmArchive() {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      await api.admin.products.archive(selected.id);
      setArchiveConfirmOpen(false);
      await loadProducts();
    } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.products.eyebrow}
        title={t.products.title}
        description={t.products.description}
        action={
          <div className="button-row">
            <Button variant="secondary" onClick={() => void loadProducts()} loading={loading}>
              <RefreshCw className="size-4" />{t.common.refresh}
            </Button>
            {canWrite ? (
              <Button onClick={() => setProductModal(true)}>
                <Plus className="size-4" />{t.products.newProduct}
              </Button>
            ) : null}
          </div>
        }
      />
      <ErrorPanel error={error} onClose={() => setError(null)} />
      {loading && products.length === 0 ? <LoadingState /> : products.length === 0 ? (
        <EmptyState
          title={t.products.emptyTitle}
          description={t.products.emptyDesc}
          action={canWrite ? <Button onClick={() => setProductModal(true)}>{t.products.createFirstProduct}</Button> : undefined}
        />
      ) : (
        <div className="master-detail">
          <aside className="master-list card">
            {products.map((product) => (
              <button
                key={product.id}
                className={product.id === selectedId ? "master-item active" : "master-item"}
                onClick={() => setSelectedId(product.id)}
              >
                <span className="item-icon"><Box className="size-4" /></span>
                <div><strong>{product.name}</strong><small>{product.id}</small></div>
                <StatusBadge status={product.status} label={product.status === "active" ? t.products.statusActive : t.products.statusArchived} />
              </button>
            ))}
          </aside>
          {selected ? (
            <div className="detail-stack">
              <Card>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">{t.products.detailEyebrow}</p>
                    <h2>{selected.name}</h2>
                    <p>{selected.description || t.products.noDescription}</p>
                  </div>
                  <StatusBadge status={selected.status} label={selected.status === "active" ? t.products.statusActive : t.products.statusArchived} />
                </div>
                <div className="metric-grid compact">
                  <div><span>{t.products.productIdLabel}</span><strong><code>{selected.id}</code></strong></div>
                  <div><span>{t.products.billingEnvLabel}</span><strong>{selected.billingEnvironment || t.products.billingEnvNone}</strong></div>
                  <div><span>{t.products.trialLabel}</span><strong>{selected.trial?.enabled ? (selected.trial.durationSeconds ? t.products.trialDays(Math.round(selected.trial.durationSeconds / 86400)) : t.products.trialEnabled) : t.products.trialDisabled}</strong></div>
                  <div><span>{t.products.tableColReleasedAt}</span><strong>{t.products.releasesCount(releases.length)}</strong></div>
                </div>
                {selected.trial?.enabled ? (
                  <Notice>
                    <strong>{t.products.trialNoticeTitle}</strong>
                    <p>{t.products.trialNoticeDesc(selected.trial.features.join(", ") || t.products.allFeatures)}</p>
                  </Notice>
                ) : null}
                {canWrite ? (
                  <div className="button-row">
                    <Button variant="secondary" onClick={openEditProduct} loading={saving}>
                      <Pencil className="size-4" />{t.products.editProduct}
                    </Button>
                    {selected.status === "active" ? (
                      <Button variant="danger" onClick={() => setArchiveConfirmOpen(true)} loading={saving}>
                        <Archive className="size-4" />{t.products.archiveProduct}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </Card>

              <Card>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">{t.products.signingEyebrow}</p>
                    <h2><KeyRound className="size-4" />{t.products.signingTitle}</h2>
                    <p>{t.products.signingDesc}</p>
                  </div>
                </div>
                {selected.signingKey ? (
                  <div className="form-stack">
                    <div className="metric-grid compact">
                      <div><span>{t.products.signingKeyIdLabel}</span><strong><code>{selected.signingKey.id}</code></strong></div>
                      <div><span>{t.products.signingAlgorithmLabel}</span><strong>{selected.signingKey.algorithm}</strong></div>
                      <div><span>{t.products.signingStatusLabel}</span><strong><StatusBadge status={selected.signingKey.status} /></strong></div>
                    </div>
                    <div className="webhook-endpoint">
                      <span className="field-label">{t.products.signingPublicKeyLabel}</span>
                      <div><code>{selected.signingKey.publicKey}</code><CopyValue value={selected.signingKey.publicKey} label={t.products.copyPublicKey} /></div>
                    </div>
                    <div className="sdk-configuration">
                      <span className="field-label">{t.products.swiftConfigLabel}</span>
                      <pre><code>{swiftConfiguration}</code></pre>
                      <CopyValue value={swiftConfiguration} label={t.products.copySwiftConfig} />
                    </div>
                  </div>
                ) : <Notice>{t.products.signingKeyMissing}</Notice>}
              </Card>

              <Card>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">{t.products.releasesEyebrow}</p>
                    <h2>{t.products.releasesTitle}</h2>
                    <p>{t.products.releasesDesc}</p>
                  </div>
                  {canWrite ? (
                    <Button onClick={() => setReleaseModal(true)}>
                      <CalendarPlus className="size-4" />{t.products.newRelease}
                    </Button>
                  ) : null}
                </div>
                {releases.length === 0 ? (
                  <EmptyState title={t.products.releasesEmptyTitle} description={t.products.releasesEmptyDesc} />
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{t.products.tableColVersionPlatform}</th>
                          <th>{t.products.tableColReleasedAt}</th>
                          <th>{t.products.tableColSha256}</th>
                          <th>{t.products.tableColDownload}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {releases.map((release) => (
                          <tr key={release.id}>
                            <td><strong>{release.version}</strong><small>{release.platform}</small></td>
                            <td>{formatDate(release.releasedAt)}</td>
                            <td><code>{release.artifactSha256.slice(0, 16)}…</code></td>
                            <td>{release.downloadUrl ? <a href={release.downloadUrl} target="_blank" rel="noreferrer">{t.products.downloadLink}</a> : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          ) : null}
        </div>
      )}

      <Modal open={productModal} onClose={() => setProductModal(false)} title={t.products.modalCreateTitle} description={t.products.modalCreateDesc}>
        <form className="form-stack" onSubmit={createProduct}>
          <Field label={t.products.fieldName}><Input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} required /></Field>
          <Field label={t.products.fieldDesc}><Textarea value={productForm.description} onChange={(event) => setProductForm({ ...productForm, description: event.target.value })} rows={3} placeholder={t.products.fieldDescPlaceholder} /></Field>
          <Field label={t.products.fieldBillingEnv}>
            <Select value={productForm.billingEnvironment} onChange={(event) => setProductForm({ ...productForm, billingEnvironment: event.target.value as BillingEnvironment | "" })}>
              <option value="">{t.products.billingEnvOptionNone}</option>
              <option value="sandbox">{t.products.billingEnvOptionSandbox}</option>
              <option value="live">{t.products.billingEnvOptionLive}</option>
            </Select>
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={productForm.trialEnabled} onChange={(event) => setProductForm({ ...productForm, trialEnabled: event.target.checked })} />
            <FlaskConical className="size-4" />
            <span>
              <strong>{t.products.fieldTrialCheck}</strong>
              <small>{t.products.fieldTrialCheckHint}</small>
            </span>
          </label>
          {productForm.trialEnabled ? (
            <div className="form-grid">
              <Field label={t.products.fieldTrialDuration} hint={t.products.fieldTrialDurationHint}><Input type="number" min="1" step="1" value={productForm.trialDurationDays} onChange={(event) => setProductForm({ ...productForm, trialDurationDays: event.target.value })} placeholder={t.products.placeholderTrialDuration} required /></Field>
              <Field label={t.products.fieldTrialFeatures} hint={t.products.fieldTrialFeaturesHint}><Input value={productForm.trialFeatures} onChange={(event) => setProductForm({ ...productForm, trialFeatures: event.target.value })} placeholder="pro_export,batch" /></Field>
            </div>
          ) : null}
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setProductModal(false)}>{t.common.cancel}</Button>
            <Button type="submit" loading={saving}><PackagePlus className="size-4" />{t.products.btnCreateProduct}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={editProductModal} onClose={() => setEditProductModal(false)} title={t.products.modalEditTitle} description={t.products.modalEditDesc}>
        <form className="form-stack" onSubmit={updateProduct}>
          <Field label={t.products.fieldName}><Input value={editProductForm.name} onChange={(event) => setEditProductForm({ ...editProductForm, name: event.target.value })} required /></Field>
          <Field label={t.products.fieldDesc}><Textarea value={editProductForm.description} onChange={(event) => setEditProductForm({ ...editProductForm, description: event.target.value })} rows={3} placeholder={t.products.fieldDescPlaceholder} /></Field>
          <Field label={t.products.fieldBillingEnv}>
            <Select value={editProductForm.billingEnvironment} onChange={(event) => setEditProductForm({ ...editProductForm, billingEnvironment: event.target.value as BillingEnvironment | "" })}>
              <option value="">{t.products.billingEnvOptionNone}</option>
              <option value="sandbox">{t.products.billingEnvOptionSandbox}</option>
              <option value="live">{t.products.billingEnvOptionLive}</option>
            </Select>
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={editProductForm.trialEnabled} onChange={(event) => setEditProductForm({ ...editProductForm, trialEnabled: event.target.checked })} />
            <FlaskConical className="size-4" />
            <span>
              <strong>{t.products.fieldTrialCheck}</strong>
              <small>{t.products.fieldTrialCheckHint}</small>
            </span>
          </label>
          {editProductForm.trialEnabled ? (
            <div className="form-grid">
              <Field label={t.products.fieldTrialDuration} hint={t.products.fieldTrialDurationHint}><Input type="number" min="1" step="1" value={editProductForm.trialDurationDays} onChange={(event) => setEditProductForm({ ...editProductForm, trialDurationDays: event.target.value })} placeholder={t.products.placeholderTrialDuration} required /></Field>
              <Field label={t.products.fieldTrialFeatures} hint={t.products.fieldTrialFeaturesHint}><Input value={editProductForm.trialFeatures} onChange={(event) => setEditProductForm({ ...editProductForm, trialFeatures: event.target.value })} placeholder="pro_export,batch" /></Field>
            </div>
          ) : null}
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setEditProductModal(false)}>{t.common.cancel}</Button>
            <Button type="submit" loading={saving}><Pencil className="size-4" />{t.products.btnSaveProduct}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={releaseModal} onClose={() => setReleaseModal(false)} title={t.products.modalReleaseTitle} description={t.products.modalReleaseDesc}>
        <form className="form-stack" onSubmit={createRelease}>
          <div className="form-grid">
            <Field label={t.products.fieldVersion}><Input value={releaseForm.version} onChange={(event) => setReleaseForm({ ...releaseForm, version: event.target.value })} placeholder="1.0.0" required /></Field>
            <Field label={t.products.fieldPlatform}><Input value={releaseForm.platform} onChange={(event) => setReleaseForm({ ...releaseForm, platform: event.target.value })} placeholder="macos-universal" required /></Field>
          </div>
          <Field label={t.products.fieldSha256}><Input value={releaseForm.artifactSha256} onChange={(event) => setReleaseForm({ ...releaseForm, artifactSha256: event.target.value })} pattern="[a-fA-F0-9]{64}" placeholder={t.products.placeholderSha256} required /></Field>
          <Field label={t.products.fieldReleasedAt}><Input type="datetime-local" value={releaseForm.releasedAt} onChange={(event) => setReleaseForm({ ...releaseForm, releasedAt: event.target.value })} required /></Field>
          <Field label={t.products.fieldDownloadUrl}><Input type="url" value={releaseForm.downloadUrl} onChange={(event) => setReleaseForm({ ...releaseForm, downloadUrl: event.target.value })} placeholder="https://..." /></Field>
          <Field label={t.products.fieldReleaseNotes}><Textarea value={releaseForm.description} onChange={(event) => setReleaseForm({ ...releaseForm, description: event.target.value })} rows={3} placeholder={t.products.fieldReleaseNotesPlaceholder} /></Field>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setReleaseModal(false)}>{t.common.cancel}</Button>
            <Button type="submit" loading={saving}>{t.products.btnCreateRelease}</Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={archiveConfirmOpen}
        title={t.products.archiveConfirmTitle}
        description={t.products.archiveConfirmDesc(selected?.name || "")}
        confirmLabel={t.products.archiveConfirmBtn}
        variant="danger"
        loading={saving}
        onConfirm={handleConfirmArchive}
        onClose={() => setArchiveConfirmOpen(false)}
      />
    </div>
  );
}
