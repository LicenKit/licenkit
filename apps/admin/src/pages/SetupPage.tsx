import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Building2, KeyRound, LockKeyhole, UserRound } from "lucide-react";
import { api, type AdminSession } from "../lib/api-client";
import { nextSetupStep, previousSetupStep, type SetupStep } from "../lib/setup-flow";
import { Button, ErrorPanel, Field, Input, Notice } from "../components/ui";

const stepNumber: Record<SetupStep, number> = { token: 1, user: 2, instance: 3 };

function SetupLayout({ step, title, description, children }: { step: SetupStep; title: string; description: string; children: ReactNode }) {
  return (
    <main className="setup-layout setup-step-layout">
      <header className="setup-intro">
        <div className="brand-mark"><KeyRound className="size-6" /></div>
        <div>
          <p className="eyebrow">一次性初始化 · {stepNumber[step]} / 3</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>
      <div className="setup-progress" aria-label={`Setup 第 ${stepNumber[step]} 步，共 3 步`}>
        {(["token", "user", "instance"] as SetupStep[]).map((item) => <span key={item} className={stepNumber[item] <= stepNumber[step] ? "active" : ""} />)}
      </div>
      {children}
    </main>
  );
}

export function SetupPage({ onSetupSuccess }: { onSetupSuccess: (session: AdminSession) => void }) {
  const [step, setStep] = useState<SetupStep>("token");
  const [setupToken, setSetupToken] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [password, setPassword] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [instanceSlug, setInstanceSlug] = useState("");
  const [siteUrl, setSiteUrl] = useState(() => window.location.origin);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function verifyToken(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.setup.verifyToken(setupToken);
      setStep(nextSetupStep("token"));
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  function collectUser(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setStep(nextSetupStep("user"));
  }

  async function completeSetup(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const session = await api.setup.complete({
        setupToken,
        user: { name: ownerName.trim(), email: ownerEmail.trim(), password },
        instance: { name: instanceName.trim(), slug: instanceSlug.trim(), siteUrl: siteUrl.trim() },
      });
      setSetupToken("");
      setPassword("");
      onSetupSuccess(session);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  if (step === "token") {
    return (
      <SetupLayout step={step} title="验证部署 Token" description="先确认你持有当前部署的初始化 Secret；通过前不收集管理员或实例信息。">
        <form className="setup-card setup-card-compact" onSubmit={verifyToken}>
          <ErrorPanel error={error} />
          <Notice tone="warning"><strong>Token 只保存在当前页面内存。</strong><p>刷新或关闭页面后需要重新输入；它不会进入 URL 或浏览器存储。</p></Notice>
          <div className="form-section">
            <div className="form-section-title"><LockKeyhole className="size-5" /><div><h2>部署验证</h2><p>输入部署时配置的 INITIAL_SETUP_TOKEN。</p></div></div>
            <Field label="INITIAL_SETUP_TOKEN"><Input type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} autoComplete="off" required autoFocus /></Field>
          </div>
          <div className="form-actions"><Button type="submit" loading={loading}>验证并继续 <ArrowRight className="size-4" /></Button></div>
        </form>
      </SetupLayout>
    );
  }

  if (step === "user") {
    return (
      <SetupLayout step={step} title="创建首位管理员用户" description="创建全局登录身份。显示名称用于界面与审计，不参与认证。">
        <form className="setup-card setup-card-compact" onSubmit={collectUser}>
          <ErrorPanel error={error} />
          <div className="form-section">
            <div className="form-section-title"><UserRound className="size-5" /><div><h2>管理员身份</h2><p>邮箱和密码用于以后登录管理端。</p></div></div>
            <Field label="显示名称"><Input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} autoComplete="name" required autoFocus /></Field>
            <Field label="邮箱"><Input type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} autoComplete="username" required /></Field>
            <Field label="密码"><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} required /></Field>
          </div>
          <div className="form-actions split-actions"><Button variant="secondary" type="button" onClick={() => { setError(null); setStep(previousSetupStep(step)) }}><ArrowLeft className="size-4" />返回</Button><Button type="submit">继续创建 Instance <ArrowRight className="size-4" /></Button></div>
        </form>
      </SetupLayout>
    );
  }

  return (
    <SetupLayout step={step} title="创建首个 Instance" description="Instance 是当前自部署中唯一的授权业务空间；首位管理员会成为 Owner。">
      <form className="setup-card setup-card-compact" onSubmit={completeSetup}>
        <ErrorPanel error={error} />
        <div className="form-section">
          <div className="form-section-title"><Building2 className="size-5" /><div><h2>Instance 信息</h2><p>最终提交会原子创建 User、Instance、Owner Membership 与管理员 Session。</p></div></div>
          <Field label="实例名称"><Input value={instanceName} onChange={(event) => setInstanceName(event.target.value)} placeholder="Example Studio Licensing" required autoFocus /></Field>
          <Field label="实例标识" hint="用于 Customer Portal、Magic Link 和支付 Webhook 等地址。只能包含小写英文字母、数字和短横线，例如 tidest。"><Input value={instanceSlug} onChange={(event) => setInstanceSlug(event.target.value.toLowerCase())} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="example-studio" required /></Field>
          <Field label="Site URL" hint="Customer Site 地址；当前自部署必须与本页面同源。"><Input type="url" value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} placeholder="https://licenses.example.com" required /></Field>
        </div>
        <div className="form-actions split-actions"><Button variant="secondary" type="button" onClick={() => { setError(null); setStep(previousSetupStep(step)) }}><ArrowLeft className="size-4" />返回</Button><Button type="submit" loading={loading}>完成初始化 <ArrowRight className="size-4" /></Button></div>
      </form>
    </SetupLayout>
  );
}
