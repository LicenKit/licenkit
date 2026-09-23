import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { api, type AdminSession } from "../lib/api-client";
import { Button, ErrorPanel, Field, Input } from "../components/ui";

export function LoginPage({ onLoginSuccess }: { onLoginSuccess: (session: AdminSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const session = await api.admin.auth.login({ email: email.trim(), password });
      onLoginSuccess(session);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="brand-mark"><KeyRound className="size-6" /></div>
        <p className="eyebrow">LicenKit</p>
        <h1>安全、可靠的独立软件授权与商业化基础设施。</h1>
        <p>统一管理软件发布、授权签发、设备激活、邮件通知及商业支付集成，提供企业级可信授权体系。</p>
        <div className="auth-principles">
          <span><ShieldCheck className="size-4" /> 严格隔离管理端与客户访问边界</span>
          <span><ShieldCheck className="size-4" /> 离线非对称签名与硬件安全绑定</span>
          <span><ShieldCheck className="size-4" /> 支付渠道 Webhook 自动闭环履约</span>
        </div>
      </section>
      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div>
            <p className="eyebrow">管理控制台</p>
            <h2>管理员登录</h2>
            <p>请输入管理员邮箱和密码以进入控制台。</p>
          </div>
          <ErrorPanel error={error} />
          <Field label="管理员邮箱">
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" placeholder="owner@example.com" required />
          </Field>
          <Field label="密码">
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </Field>
          <Button className="w-full" type="submit" loading={loading}>登录 <ArrowRight className="size-4" /></Button>
          <p className="auth-footnote">最终客户请前往客户门户通过邮箱安全链接登录，无需使用管理端账号。</p>
        </form>
      </section>
    </main>
  );
}
