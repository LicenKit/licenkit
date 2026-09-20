import { useState, type FormEvent } from "react";
import { ArrowRight, Building2, KeyRound, LockKeyhole, UserRound } from "lucide-react";
import { api, type AdminSession } from "../lib/api-client";
import { Button, ErrorPanel, Field, Input, Notice } from "../components/ui";

export function SetupPage({ onSetupSuccess }: { onSetupSuccess: (session: AdminSession) => void }) {
  const [setupToken, setSetupToken] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [accountSlug, setAccountSlug] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await api.setup.complete({
        setupToken,
        instanceName: instanceName.trim(),
        accountSlug: accountSlug.trim(),
        owner: { name: ownerName.trim(), email: ownerEmail.trim(), password },
      });
      setSetupToken("");
      setPassword("");
      onSetupSuccess({ account: result.account, user: result.owner });
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="setup-layout">
      <header className="setup-intro">
        <div className="brand-mark"><KeyRound className="size-6" /></div>
        <div>
          <p className="eyebrow">一次性初始化</p>
          <h1>创建首个账户与 Owner</h1>
          <p>这一步会在一个原子操作中创建实例设置、Account、首位 Owner 和管理员 Session。成功后 Setup 永久关闭。</p>
        </div>
      </header>
      <form className="setup-card" onSubmit={submit}>
        <ErrorPanel error={error} />
        <Notice tone="warning"><strong>部署密钥只用于本次提交。</strong><p>Setup Token 不会进入 URL、浏览器存储或错误回显。</p></Notice>
        <div className="form-section">
          <div className="form-section-title"><LockKeyhole className="size-5" /><div><h2>部署验证</h2><p>输入部署时配置的 INITIAL_SETUP_TOKEN。</p></div></div>
          <Field label="Setup Token"><Input type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} autoComplete="off" required /></Field>
        </div>
        <div className="form-section">
          <div className="form-section-title"><Building2 className="size-5" /><div><h2>实例与账户</h2><p>slug 将用于管理登录和公开产品路径。</p></div></div>
          <div className="form-grid">
            <Field label="实例名称"><Input value={instanceName} onChange={(event) => setInstanceName(event.target.value)} placeholder="Example Studio Licensing" required /></Field>
            <Field label="账户 slug" hint="小写 URL-safe，例如 example-studio"><Input value={accountSlug} onChange={(event) => setAccountSlug(event.target.value.toLowerCase())} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="example-studio" required /></Field>
          </div>
        </div>
        <div className="form-section">
          <div className="form-section-title"><UserRound className="size-5" /><div><h2>首位 Owner</h2><p>Owner 可管理账户、团队和全部业务资源。</p></div></div>
          <div className="form-grid">
            <Field label="姓名"><Input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} autoComplete="name" required /></Field>
            <Field label="邮箱"><Input type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} autoComplete="username" required /></Field>
          </div>
          <Field label="密码"><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} required /></Field>
        </div>
        <div className="form-actions"><Button type="submit" loading={loading}>完成初始化 <ArrowRight className="size-4" /></Button></div>
      </form>
    </main>
  );
}
