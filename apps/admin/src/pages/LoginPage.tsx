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
        <p className="eyebrow">LicenKit V1</p>
        <h1>把可信购买事实，转换为可执行的授权事实。</h1>
        <p>管理产品发布、授权条款、客户、支付履约和通知投递。管理员会话与客户授权中心完全隔离。</p>
        <div className="auth-principles">
          <span><ShieldCheck className="size-4" /> 服务端 Session 与默认拒绝权限</span>
          <span><ShieldCheck className="size-4" /> 原始错误与外部事件链路可诊断</span>
          <span><ShieldCheck className="size-4" /> 授权条款签发后不可被模板编辑追溯修改</span>
        </div>
      </section>
      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div>
            <p className="eyebrow">管理控制台</p>
            <h2>登录管理端</h2>
            <p>使用管理员邮箱和密码登录。当前自部署会自动进入唯一的 Instance。</p>
          </div>
          <ErrorPanel error={error} />
          <Field label="管理员邮箱">
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" placeholder="owner@example.com" required />
          </Field>
          <Field label="密码">
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </Field>
          <Button className="w-full" type="submit" loading={loading}>登录 <ArrowRight className="size-4" /></Button>
          <p className="auth-footnote">购买者请使用客户授权中心的 Magic Link 登录，不使用管理员密码。</p>
        </form>
      </section>
    </main>
  );
}
