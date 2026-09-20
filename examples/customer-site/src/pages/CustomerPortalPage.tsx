import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Copy, ExternalLink, KeyRound, Laptop, LogOut, RefreshCw, ShieldAlert } from "lucide-react";
import { api, isApiError, type Activation, type Customer, type CustomerLicense, type KeyRotationResponse } from "../lib/api-client";
import { Badge, Button, Card, EmptyState, ErrorPanel, LoadingState, Notice, StatusBadge, formatDate } from "../components/ui";

type PortalView = "loading" | "failure" | "login" | "consume" | "portal";

export function CustomerPortalPage({ accountSlug }: { accountSlug: string }) {
  const [magicToken, setMagicToken] = useState(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return token;
  });
  const [view, setView] = useState<PortalView>(magicToken ? "consume" : "loading");
  const [session, setSession] = useState<Customer | null>(null);
  const [licenses, setLicenses] = useState<CustomerLicense[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activations, setActivations] = useState<Activation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [oneTimeCredential, setOneTimeCredential] = useState<KeyRotationResponse | null>(null);
  const [recentAuthRequired, setRecentAuthRequired] = useState(false);
  const selected = licenses.find((license) => license.id === selectedId) ?? null;

  useEffect(() => {
    if (magicToken) return;
    void api.customer.me().then(async (current) => {
      setSession(current);
      setView("portal");
      await loadLicenses();
    }).catch((caught: unknown) => {
      if (isApiError(caught) && (caught.status === 401 || caught.status === 403)) setView("login");
      else { setError(caught); setView("failure"); }
    });
  }, [magicToken]);

  useEffect(() => {
    if (view !== "login") return;
    const target = new URL("/customer-magic-link.html", window.location.origin);
    target.searchParams.set("accountSlug", accountSlug);
    window.location.replace(target.href);
  }, [accountSlug, view]);

  useEffect(() => {
    setOneTimeCredential(null);
    if (!selectedId || view !== "portal") {
      setActivations([]);
      return;
    }
    void api.customer.licenses.activations(selectedId).then((result) => setActivations(result.items)).catch(setError);
  }, [selectedId, view]);

  async function loadLicenses() {
    const result = await api.customer.licenses.list();
    setLicenses(result.items);
    setSelectedId((current) => current && result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? null);
  }

  async function consumeLink() {
    if (!magicToken) return;
    setLoading(true);
    setError(null);
    try {
      await api.customer.auth.consumeMagicLink({ accountSlug, token: magicToken });
      setMagicToken(null);
      setSession(await api.customer.me());
      setView("portal");
      await loadLicenses();
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  function handleActionError(caught: unknown) {
    setError(caught);
    if (isApiError(caught) && caught.code === "CUSTOMER_RECENT_AUTH_REQUIRED") setRecentAuthRequired(true);
  }

  async function sensitiveAction(kind: "recover" | "reset") {
    if (!selected) return;
    const warning = kind === "recover"
      ? "将生成新注册码并让旧注册码立即失效；已有激活保持不变。是否继续？"
      : "安全重置会生成新注册码，并吊销全部现有激活。所有设备都必须重新激活。是否继续？";
    if (!window.confirm(warning)) return;
    setLoading(true);
    setError(null);
    try {
      const result = kind === "recover" ? await api.customer.licenses.recoverKey(selected.id) : await api.customer.licenses.securityReset(selected.id);
      setOneTimeCredential(result);
      await loadLicenses();
    } catch (caught) {
      handleActionError(caught);
    } finally {
      setLoading(false);
    }
  }

  async function deactivate(activation: Activation) {
    if (!selected || !window.confirm(`释放设备“${activation.name || activation.id}”的席位？设备历史会保留。`)) return;
    setLoading(true);
    setError(null);
    try {
      await api.customer.licenses.deactivate(selected.id, activation.id);
      setActivations((items) => items.map((item) => item.id === activation.id ? { ...item, status: "deactivated" } : item));
    } catch (caught) {
      handleActionError(caught);
    } finally {
      setLoading(false);
    }
  }

  async function openBillingPortal() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.customer.licenses.portalSession(selected.id);
      window.location.assign(result.url);
    } catch (caught) {
      handleActionError(caught);
      setLoading(false);
    }
  }

  async function logout() {
    setError(null);
    try {
      await api.customer.auth.logout();
    } catch (caught) {
      setError(caught);
      return;
    }
    setSession(null);
    setLicenses([]);
    setSelectedId(null);
    setOneTimeCredential(null);
    setView("login");
  }

  if (view === "loading") return <main className="centered-page"><LoadingState label="正在检查客户会话" /></main>;

  if (view === "failure") return <main className="centered-page"><section className="connection-error card"><h1>无法确认客户会话</h1><p>网络或服务端错误不能被当作未登录。修复连接后重新检查。</p><ErrorPanel error={error} /><Button onClick={() => window.location.reload()}>重新连接</Button></section></main>;

  if (view === "consume") {
    return (
      <main className="portal-auth-page">
        <Card className="portal-auth-card">
          <div className="brand-mark"><KeyRound className="size-6" /></div>
          <p className="eyebrow">客户授权中心</p>
          <h1>继续登录</h1>
          <p>链接已从地址栏清除。只有你点击下方按钮后，一次性 Magic Link 才会被消费。</p>
          <ErrorPanel error={error} />
          <Button loading={loading} onClick={() => void consumeLink()}>继续登录 <ArrowRight className="size-4" /></Button>
        </Card>
      </main>
    );
  }

  if (view === "login") {
    return <main className="centered-page"><LoadingState label="正在前往安全登录请求页" /></main>;
  }

  return (
    <main className="customer-shell">
      <header className="customer-topbar">
        <div className="brand-inline"><span className="brand-mark small"><KeyRound className="size-4" /></span><div><strong>{accountSlug}</strong><span>客户授权中心</span></div></div>
        <div className="customer-identity"><span>{session?.email}</span><Button variant="ghost" onClick={() => void logout()}><LogOut className="size-4" />退出</Button></div>
      </header>
      <div className="customer-content">
        <header className="page-header"><div><p className="eyebrow">你的授权</p><h1>License 与设备</h1><p>查看授权状态、释放设备席位、找回注册码或进入支付平台管理订阅。</p></div></header>
        <ErrorPanel error={error} />
        {recentAuthRequired ? (
          <Notice tone="warning"><strong>此操作需要最近 15 分钟内完成认证。</strong><p>退出后重新请求 Magic Link，再返回执行操作。普通确认弹窗不能替代重新认证。</p><Button variant="secondary" onClick={() => void logout()}>重新认证</Button></Notice>
        ) : null}
        {oneTimeCredential ? (
          <div className="credential-reveal" role="status">
            <div><p className="eyebrow">仅显示一次</p><h2>新注册码已生成</h2><p>旧注册码已失效。通知状态：<StatusBadge status={oneTimeCredential.delivery?.status} /></p></div>
            <code>{oneTimeCredential.licenseKey}</code>
            <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(oneTimeCredential.licenseKey)}><Copy className="size-4" />复制注册码</Button>
            <Button variant="ghost" onClick={() => setOneTimeCredential(null)}><Check className="size-4" />我已保存</Button>
          </div>
        ) : null}
        {licenses.length === 0 ? <EmptyState title="暂无授权" description="完成购买或由发行方签发后，License 会出现在这里。" /> : (
          <div className="customer-grid">
            <aside className="license-picker card">
              {licenses.map((license) => (
                <button key={license.id} className={license.id === selectedId ? "license-choice active" : "license-choice"} onClick={() => setSelectedId(license.id)}>
                  <div><strong>{license.productName || license.productId}</strong><span>{license.id}</span></div><StatusBadge status={license.status} />
                </button>
              ))}
            </aside>
            {selected ? (
              <section className="license-portal-detail">
                <Card>
                  <div className="card-header"><div><p className="eyebrow">License</p><h2>{selected.productName || selected.productId}</h2><p className="mono">{selected.id}</p></div><StatusBadge status={selected.status} /></div>
                  <div className="metric-grid compact">
                    <div><span>授权模型</span><strong>{selected.licenseModel}</strong></div>
                    <div><span>续期方式</span><strong>{selected.renewalMode}</strong></div>
                    <div><span>到期时间</span><strong>{formatDate(selected.expiresAt)}</strong></div>
                    <div><span>版本更新权益</span><strong>{selected.updatesUntil ? formatDate(selected.updatesUntil) : "不限制"}</strong></div>
                  </div>
                  <div className="button-row">
                    <Button variant="secondary" loading={loading} onClick={() => void sensitiveAction("recover")}><RefreshCw className="size-4" />生成新注册码并发送</Button>
                    <Button variant="danger" loading={loading} onClick={() => void sensitiveAction("reset")}><ShieldAlert className="size-4" />安全重置</Button>
                    {selected.renewalMode === "billing" ? <Button loading={loading} onClick={() => void openBillingPortal()}><ExternalLink className="size-4" />管理支付订阅</Button> : null}
                  </div>
                  {selected.renewalMode === "manual" ? <p className="support-note">此订阅由发行方手动续期，不提供支付平台管理入口。</p> : null}
                </Card>
                <Card>
                  <div className="card-header"><div><p className="eyebrow">Activation</p><h2>已授权设备</h2><p>释放席位会保留设备历史，不会吊销 License。</p></div><Badge>{activations.filter((item) => item.status === "active").length} active</Badge></div>
                  {activations.length === 0 ? <EmptyState title="尚无设备" description="客户端激活后会显示在这里。" /> : (
                    <div className="stack-list">{activations.map((activation) => (
                      <div className="stack-row" key={activation.id}>
                        <Laptop className="size-5" />
                        <div className="grow"><strong>{activation.name || "未命名设备"}</strong><span>{activation.platform || "未知平台"} · 最近验证 {formatDate(activation.lastValidatedAt)}</span></div>
                        <StatusBadge status={activation.status} />
                        {activation.status === "active" ? <Button variant="secondary" loading={loading} onClick={() => void deactivate(activation)}>释放席位</Button> : null}
                      </div>
                    ))}</div>
                  )}
                </Card>
              </section>
            ) : null}
          </div>
        )}
      </div>
      <footer className="customer-footer"><AlertTriangle className="size-4" />注册码找回会轮换新码；安全重置还会吊销全部现有设备。</footer>
    </main>
  );
}
