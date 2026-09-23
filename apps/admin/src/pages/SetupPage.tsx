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
  const [adminApiUrl, setAdminApiUrl] = useState(() => window.location.origin);
  const [customerSiteUrl, setCustomerSiteUrl] = useState("");
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
        instance: {
          name: instanceName.trim(),
          slug: instanceSlug.trim(),
          adminApiUrl: adminApiUrl.trim(),
          customerSiteUrl: customerSiteUrl.trim(),
        },
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
      <SetupLayout step={step} title="验证系统初始化密钥" description="请输入服务端部署时配置的 Setup Secret，以确认系统部署所有权。">
        <form className="setup-card setup-card-compact" onSubmit={verifyToken}>
          <ErrorPanel error={error} />
          <Notice tone="info"><strong>密钥安全提示</strong><p>密钥仅保存在当前会话内存中，不会持久化存储到浏览器本地。</p></Notice>
          <div className="form-section">
            <div className="form-section-title"><LockKeyhole className="size-5" /><div><h2>部署所有权验证</h2><p>输入环境变量 INITIAL_SETUP_TOKEN 的值。</p></div></div>
            <Field label="初始化密钥 (INITIAL_SETUP_TOKEN)"><Input type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} autoComplete="off" placeholder="输入初始化 Token..." required autoFocus /></Field>
          </div>
          <div className="form-actions"><Button type="submit" loading={loading}>验证并继续 <ArrowRight className="size-4" /></Button></div>
        </form>
      </SetupLayout>
    );
  }

  if (step === "user") {
    return (
      <SetupLayout step={step} title="创建超级管理员账号" description="设置系统首位管理员凭据，该账号将自动拥有工作空间的所有者 (Owner) 权限。">
        <form className="setup-card setup-card-compact" onSubmit={collectUser}>
          <ErrorPanel error={error} />
          <div className="form-section">
            <div className="form-section-title"><UserRound className="size-5" /><div><h2>管理员身份</h2><p>用于后续登录管理后台的凭证。</p></div></div>
            <Field label="管理员姓名"><Input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} autoComplete="name" placeholder="例如：Alex" required autoFocus /></Field>
            <Field label="管理员邮箱"><Input type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} autoComplete="username" placeholder="admin@example.com" required /></Field>
            <Field label="登录密码" hint="长度不少于 12 位，建议混合大小写字母与数字"><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} required /></Field>
          </div>
          <div className="form-actions split-actions"><Button variant="secondary" type="button" onClick={() => { setError(null); setStep(previousSetupStep(step)) }}><ArrowLeft className="size-4" />返回</Button><Button type="submit">下一步：配置工作空间 <ArrowRight className="size-4" /></Button></div>
        </form>
      </SetupLayout>
    );
  }

  return (
    <SetupLayout step={step} title="配置工作空间" description="创建首个授权管理空间，用于承载软件产品、授权方案及客户账单数据。">
      <form className="setup-card setup-card-compact" onSubmit={completeSetup}>
        <ErrorPanel error={error} />
        <div className="form-section">
          <div className="form-section-title"><Building2 className="size-5" /><div><h2>空间信息</h2><p>完成配置后，系统将正式开启并为您生成管理员登录凭据。</p></div></div>
          <Field label="空间名称"><Input value={instanceName} onChange={(event) => setInstanceName(event.target.value)} placeholder="例如：Acme Licensing" required autoFocus /></Field>
          <Field label="空间标识 (Slug)" hint="用于系统内部唯一标识，仅限小写字母、数字与中划线"><Input value={instanceSlug} onChange={(event) => setInstanceSlug(event.target.value.toLowerCase())} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="例如：acme-licensing" required /></Field>
          <Field label="LicenKit Admin/API 地址" hint="LicenKit 管理后台和 API 使用的公开域名，必须与当前访问 Setup 的 Worker Origin 一致。"><Input type="url" value={adminApiUrl} onChange={(event) => setAdminApiUrl(event.target.value)} placeholder="https://license.example.com" required /></Field>
          <Field label="Customer Site 地址" hint="用户自己的官网地址，用于承载 Customer Portal、Magic Link 落地页和购买结果页。它必须与 LicenKit Admin/API 地址保持同协议、同可注册站点。"><Input type="url" value={customerSiteUrl} onChange={(event) => setCustomerSiteUrl(event.target.value)} placeholder="https://example.com" required /></Field>
        </div>
        <div className="form-actions split-actions"><Button variant="secondary" type="button" onClick={() => { setError(null); setStep(previousSetupStep(step)) }}><ArrowLeft className="size-4" />返回</Button><Button type="submit" loading={loading}>完成初始化 <ArrowRight className="size-4" /></Button></div>
      </form>
    </SetupLayout>
  );
}
