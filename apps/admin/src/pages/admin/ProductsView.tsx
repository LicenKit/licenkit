import { useEffect, useState, type FormEvent } from "react";
import { Archive, Box, CalendarPlus, FlaskConical, PackagePlus, Plus, RefreshCw } from "lucide-react";
import { api, type BillingEnvironment, type Product, type ProductRelease } from "../../lib/api-client";
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, Select, StatusBadge, Textarea, formatDate } from "../../components/ui";

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

  async function archiveProduct() {
    if (!selected || !window.confirm(`归档 Product“${selected.name}”？已有 License 不受影响。`)) return;
    setSaving(true); setError(null);
    try { await api.admin.products.archive(selected.id); await loadProducts() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="授权目录" title="产品与发布" description="Product 定义被授权软件；Product Release 是版本更新权益判断的受信发布事实。" action={<div className="button-row"><Button variant="secondary" onClick={() => void loadProducts()} loading={loading}><RefreshCw className="size-4" />刷新</Button>{canWrite ? <Button onClick={() => setProductModal(true)}><Plus className="size-4" />新建 Product</Button> : null}</div>} />
      <ErrorPanel error={error} />
      {loading && products.length === 0 ? <LoadingState /> : products.length === 0 ? <EmptyState title="还没有 Product" description="创建 Product 后再建立发布记录和授权方案。" action={canWrite ? <Button onClick={() => setProductModal(true)}>创建第一个 Product</Button> : undefined} /> : (
        <div className="master-detail">
          <aside className="master-list card">
            {products.map((product) => <button key={product.id} className={product.id === selectedId ? "master-item active" : "master-item"} onClick={() => setSelectedId(product.id)}><span className="item-icon"><Box className="size-4" /></span><div><strong>{product.name}</strong><small>/{product.slug}</small></div><StatusBadge status={product.status} /></button>)}
          </aside>
          {selected ? <div className="detail-stack">
            <Card>
              <div className="card-header"><div><p className="eyebrow">Product</p><h2>{selected.name}</h2><p>{selected.description || "暂无说明"}</p></div><StatusBadge status={selected.status} /></div>
              <div className="metric-grid compact">
                <div><span>公开 slug</span><strong>/{selected.slug}</strong></div>
                <div><span>公开收款环境</span><strong>{selected.billingEnvironment || "未配置"}</strong></div>
                <div><span>设备试用</span><strong>{selected.trial?.enabled ? `${selected.trial.durationSeconds || 0} 秒` : "未启用"}</strong></div>
                <div><span>Release</span><strong>{releases.length}</strong></div>
              </div>
              {selected.trial?.enabled ? <Notice><strong>无需支付方式的设备试用</strong><p>功能：{selected.trial.features.join(", ") || "无"}。已领取 Trial Claim 不会随配置修改。</p></Notice> : null}
              {canWrite && selected.status === "active" ? <div className="button-row"><Button variant="danger" onClick={() => void archiveProduct()} loading={saving}><Archive className="size-4" />归档 Product</Button></div> : null}
            </Card>
            <Card>
              <div className="card-header"><div><p className="eyebrow">Product Release</p><h2>受信发布记录</h2><p>版本、平台、发布时间与 SHA-256 创建后不可原地修改。</p></div>{canWrite ? <Button onClick={() => setReleaseModal(true)}><CalendarPlus className="size-4" />登记 Release</Button> : null}</div>
              {releases.length === 0 ? <EmptyState title="暂无发布记录" description="客户端激活和校验只接受这里登记的版本与平台。" /> : <div className="table-wrap"><table><thead><tr><th>版本 / 平台</th><th>发布时间</th><th>SHA-256</th><th>下载</th></tr></thead><tbody>{releases.map((release) => <tr key={release.id}><td><strong>{release.version}</strong><small>{release.platform}</small></td><td>{formatDate(release.releasedAt)}</td><td><code>{release.artifactSha256.slice(0, 16)}…</code></td><td>{release.downloadUrl ? <a href={release.downloadUrl} target="_blank" rel="noreferrer">下载地址</a> : "—"}</td></tr>)}</tbody></table></div>}
            </Card>
          </div> : null}
        </div>
      )}

      <Modal open={productModal} onClose={() => setProductModal(false)} title="新建 Product" description="收款环境可以先留空；存在 active Offer 或正式支付 License 后将被锁定。">
        <form className="form-stack" onSubmit={createProduct}>
          <div className="form-grid"><Field label="名称"><Input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} required /></Field><Field label="公开 slug"><Input value={productForm.slug} onChange={(event) => setProductForm({ ...productForm, slug: event.target.value.toLowerCase() })} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required /></Field></div>
          <Field label="说明"><Textarea value={productForm.description} onChange={(event) => setProductForm({ ...productForm, description: event.target.value })} rows={3} /></Field>
          <Field label="公开收款环境"><Select value={productForm.billingEnvironment} onChange={(event) => setProductForm({ ...productForm, billingEnvironment: event.target.value as BillingEnvironment | "" })}><option value="">不开放公开收款</option><option value="sandbox">Sandbox</option><option value="live">Live</option></Select></Field>
          <label className="check-row"><input type="checkbox" checked={productForm.trialEnabled} onChange={(event) => setProductForm({ ...productForm, trialEnabled: event.target.checked })} /><FlaskConical className="size-4" /><span><strong>启用 Product/设备级 Trial Claim</strong><small>无需支付方式、必须在线校验，与 Paddle 免费订阅试用不同。</small></span></label>
          {productForm.trialEnabled ? <div className="form-grid"><Field label="试用时长（秒）"><Input type="number" min="1" value={productForm.trialDurationSeconds} onChange={(event) => setProductForm({ ...productForm, trialDurationSeconds: event.target.value })} required /></Field><Field label="试用功能" hint="用英文逗号分隔"><Input value={productForm.trialFeatures} onChange={(event) => setProductForm({ ...productForm, trialFeatures: event.target.value })} /></Field></div> : null}
          <div className="form-actions"><Button variant="secondary" type="button" onClick={() => setProductModal(false)}>取消</Button><Button type="submit" loading={saving}><PackagePlus className="size-4" />创建</Button></div>
        </form>
      </Modal>

      <Modal open={releaseModal} onClose={() => setReleaseModal(false)} title="登记 Product Release" description="新二进制或新 Hash 必须创建新的 Release。">
        <form className="form-stack" onSubmit={createRelease}>
          <div className="form-grid"><Field label="版本"><Input value={releaseForm.version} onChange={(event) => setReleaseForm({ ...releaseForm, version: event.target.value })} placeholder="2.4.0" required /></Field><Field label="发布工件平台"><Input value={releaseForm.platform} onChange={(event) => setReleaseForm({ ...releaseForm, platform: event.target.value })} placeholder="macos-universal" required /></Field></div>
          <Field label="SHA-256"><Input value={releaseForm.artifactSha256} onChange={(event) => setReleaseForm({ ...releaseForm, artifactSha256: event.target.value })} pattern="[a-fA-F0-9]{64}" placeholder="64 位十六进制" required /></Field>
          <Field label="可信 UTC 发布时间"><Input type="datetime-local" value={releaseForm.releasedAt} onChange={(event) => setReleaseForm({ ...releaseForm, releasedAt: event.target.value })} required /></Field>
          <Field label="下载地址"><Input type="url" value={releaseForm.downloadUrl} onChange={(event) => setReleaseForm({ ...releaseForm, downloadUrl: event.target.value })} placeholder="https://…" /></Field>
          <Field label="发布说明"><Textarea value={releaseForm.description} onChange={(event) => setReleaseForm({ ...releaseForm, description: event.target.value })} rows={3} /></Field>
          <div className="form-actions"><Button variant="secondary" type="button" onClick={() => setReleaseModal(false)}>取消</Button><Button type="submit" loading={saving}>登记 Release</Button></div>
        </form>
      </Modal>
    </div>
  );
}
