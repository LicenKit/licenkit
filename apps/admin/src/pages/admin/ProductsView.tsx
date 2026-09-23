import { useEffect, useState, type FormEvent } from "react";
import { Archive, Box, CalendarPlus, FlaskConical, PackagePlus, Plus, RefreshCw } from "lucide-react";
import { api, type BillingEnvironment, type Product, type ProductRelease } from "../../lib/api-client";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, Select, StatusBadge, Textarea, formatDate } from "../../components/ui";

const emptyProduct = { slug: "", name: "", description: "", billingEnvironment: "" as BillingEnvironment | "", trialEnabled: false, trialDurationSeconds: "", trialFeatures: "" };
const emptyRelease = { version: "", platform: "", description: "", downloadUrl: "", artifactSha256: "", releasedAt: "" };

export function ProductsView({ canWrite }: { canWrite: boolean }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [releases, setReleases] = useState<ProductRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [productModal, setProductModal] = useState(false);
  const [releaseModal, setReleaseModal] = useState(false);
  const [productForm, setProductForm] = useState(emptyProduct);
  const [releaseForm, setReleaseForm] = useState(emptyRelease);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const selected = products.find((product) => product.id === selectedId) ?? null;

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
        slug: productForm.slug.trim(), name: productForm.name.trim(), description: productForm.description.trim() || null,
        billingEnvironment: productForm.billingEnvironment || null,
        trial: { enabled: productForm.trialEnabled, durationSeconds: productForm.trialEnabled ? Number(productForm.trialDurationSeconds) : undefined, features: productForm.trialFeatures.split(",").map((item) => item.trim()).filter(Boolean) },
      });
      setProductModal(false); setProductForm(emptyProduct); await loadProducts(); setSelectedId(created.id);
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
        eyebrow="授权目录"
        title="产品与发布"
        description="管理软件产品的定义与官方版本发布记录。登记的版本用于客户端更新校验与版本权益判定。"
        action={
          <div className="button-row">
            <Button variant="secondary" onClick={() => void loadProducts()} loading={loading}>
              <RefreshCw className="size-4" />刷新
            </Button>
            {canWrite ? (
              <Button onClick={() => setProductModal(true)}>
                <Plus className="size-4" />新建产品
              </Button>
            ) : null}
          </div>
        }
      />
      <ErrorPanel error={error} />
      {loading && products.length === 0 ? <LoadingState /> : products.length === 0 ? (
        <EmptyState
          title="暂无产品"
          description="创建产品后即可登记发布版本，并配置对应的授权方案。"
          action={canWrite ? <Button onClick={() => setProductModal(true)}>创建第一个产品</Button> : undefined}
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
                <div><strong>{product.name}</strong><small>/{product.slug}</small></div>
                <StatusBadge status={product.status} label={product.status === "active" ? "正常" : "已归档"} />
              </button>
            ))}
          </aside>
          {selected ? (
            <div className="detail-stack">
              <Card>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">产品详情</p>
                    <h2>{selected.name}</h2>
                    <p>{selected.description || "暂无产品说明"}</p>
                  </div>
                  <StatusBadge status={selected.status} label={selected.status === "active" ? "正常" : "已归档"} />
                </div>
                <div className="metric-grid compact">
                  <div><span>公开标识 (slug)</span><strong>/{selected.slug}</strong></div>
                  <div><span>收款环境</span><strong>{selected.billingEnvironment || "未开放公开收款"}</strong></div>
                  <div><span>设备试用</span><strong>{selected.trial?.enabled ? (selected.trial.durationSeconds ? `${Math.round(selected.trial.durationSeconds / 86400)} 天` : "已启用") : "未启用"}</strong></div>
                  <div><span>已登记版本</span><strong>{releases.length} 个</strong></div>
                </div>
                {selected.trial?.enabled ? (
                  <Notice>
                    <strong>设备级在线试用功能</strong>
                    <p>试用功能白名单：{selected.trial.features.join(", ") || "全部功能"}。客户设备激活试用后即可在指定期限内使用。</p>
                  </Notice>
                ) : null}
                {canWrite && selected.status === "active" ? (
                  <div className="button-row">
                    <Button variant="danger" onClick={() => setArchiveConfirmOpen(true)} loading={saving}>
                      <Archive className="size-4" />归档产品
                    </Button>
                  </div>
                ) : null}
              </Card>

              <Card>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">版本发布</p>
                    <h2>版本发布</h2>
                    <p>版本号、架构平台、发布时间与 SHA-256 哈希创建后不可原地修改，用于客户端升级权益校验。</p>
                  </div>
                  {canWrite ? (
                    <Button onClick={() => setReleaseModal(true)}>
                      <CalendarPlus className="size-4" />登记新版本
                    </Button>
                  ) : null}
                </div>
                {releases.length === 0 ? (
                  <EmptyState title="暂无发布记录" description="在此登记软件的发布版本，客户端更新校验只接受此处登记的受信版本。" />
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>版本 / 平台</th>
                          <th>发布时间</th>
                          <th>SHA-256 哈希</th>
                          <th>下载</th>
                        </tr>
                      </thead>
                      <tbody>
                        {releases.map((release) => (
                          <tr key={release.id}>
                            <td><strong>{release.version}</strong><small>{release.platform}</small></td>
                            <td>{formatDate(release.releasedAt)}</td>
                            <td><code>{release.artifactSha256.slice(0, 16)}…</code></td>
                            <td>{release.downloadUrl ? <a href={release.downloadUrl} target="_blank" rel="noreferrer">下载地址</a> : "—"}</td>
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

      <Modal open={productModal} onClose={() => setProductModal(false)} title="新建产品" description="收款环境可先保持为空；后续绑定生效定价或签发正式授权后环境将被锁定。">
        <form className="form-stack" onSubmit={createProduct}>
          <div className="form-grid">
            <Field label="产品名称"><Input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} required /></Field>
            <Field label="公开标识 (slug)"><Input value={productForm.slug} onChange={(event) => setProductForm({ ...productForm, slug: event.target.value.toLowerCase() })} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="my-app" required /></Field>
          </div>
          <Field label="说明"><Textarea value={productForm.description} onChange={(event) => setProductForm({ ...productForm, description: event.target.value })} rows={3} placeholder="简要说明软件产品定位..." /></Field>
          <Field label="公开收款环境">
            <Select value={productForm.billingEnvironment} onChange={(event) => setProductForm({ ...productForm, billingEnvironment: event.target.value as BillingEnvironment | "" })}>
              <option value="">不开放公开收款</option>
              <option value="sandbox">Sandbox (沙箱测试)</option>
              <option value="live">Live (生产环境)</option>
            </Select>
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={productForm.trialEnabled} onChange={(event) => setProductForm({ ...productForm, trialEnabled: event.target.checked })} />
            <FlaskConical className="size-4" />
            <span>
              <strong>启用设备在线试用</strong>
              <small>允许设备在不绑定支付方式的情况下在线领取临时试用凭证，需在线验签。</small>
            </span>
          </label>
          {productForm.trialEnabled ? (
            <div className="form-grid">
              <Field label="试用时长（秒）" hint="设备试用的有效秒数。参考：7 天 = 604800"><Input type="number" min="1" value={productForm.trialDurationSeconds} onChange={(event) => setProductForm({ ...productForm, trialDurationSeconds: event.target.value })} placeholder="604800 (7天)" required /></Field>
              <Field label="试用功能白名单" hint="用英文逗号分隔"><Input value={productForm.trialFeatures} onChange={(event) => setProductForm({ ...productForm, trialFeatures: event.target.value })} placeholder="pro_export,batch" /></Field>
            </div>
          ) : null}
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setProductModal(false)}>取消</Button>
            <Button type="submit" loading={saving}><PackagePlus className="size-4" />创建产品</Button>
          </div>
        </form>
      </Modal>

      <Modal open={releaseModal} onClose={() => setReleaseModal(false)} title="登记新版本" description="新编译的安装包或更新哈希需创建新版本，创建后不可修改。">
        <form className="form-stack" onSubmit={createRelease}>
          <div className="form-grid">
            <Field label="版本号"><Input value={releaseForm.version} onChange={(event) => setReleaseForm({ ...releaseForm, version: event.target.value })} placeholder="1.0.0" required /></Field>
            <Field label="适用平台与架构"><Input value={releaseForm.platform} onChange={(event) => setReleaseForm({ ...releaseForm, platform: event.target.value })} placeholder="macos-universal" required /></Field>
          </div>
          <Field label="安装包 SHA-256 哈希"><Input value={releaseForm.artifactSha256} onChange={(event) => setReleaseForm({ ...releaseForm, artifactSha256: event.target.value })} pattern="[a-fA-F0-9]{64}" placeholder="64 位十六进制哈希" required /></Field>
          <Field label="发布时间"><Input type="datetime-local" value={releaseForm.releasedAt} onChange={(event) => setReleaseForm({ ...releaseForm, releasedAt: event.target.value })} required /></Field>
          <Field label="下载地址（可选）"><Input type="url" value={releaseForm.downloadUrl} onChange={(event) => setReleaseForm({ ...releaseForm, downloadUrl: event.target.value })} placeholder="https://..." /></Field>
          <Field label="版本更新说明"><Textarea value={releaseForm.description} onChange={(event) => setReleaseForm({ ...releaseForm, description: event.target.value })} rows={3} placeholder="简要描述此版本更新内容..." /></Field>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setReleaseModal(false)}>取消</Button>
            <Button type="submit" loading={saving}>登记版本</Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={archiveConfirmOpen}
        title="归档产品"
        description={`确定归档产品“${selected?.name}”？归档后该产品将无法继续签发新授权或创建新定价，已售出的存量授权及激活不受任何影响。`}
        confirmLabel="确认归档"
        variant="danger"
        loading={saving}
        onConfirm={handleConfirmArchive}
        onClose={() => setArchiveConfirmOpen(false)}
      />
    </div>
  );
}
