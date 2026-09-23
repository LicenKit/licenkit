import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, KeyRound, Loader2, ShieldCheck, UserPlus } from "lucide-react";
import { api, isApiError, type AdminSession } from "../lib/api-client";
import { acceptInvitationForExistingUser } from "../lib/invitation-acceptance";
import { readAndClearInvitationToken } from "../lib/invitation-fragment";
import { Button, ErrorPanel, Field, Input, Notice } from "../components/ui";
import { LanguageSwitcher } from "../components/LanguageSwitcher";

type Mode = "existing" | "new";

export function InvitationAcceptPage({ onAccepted }: { onAccepted: (session: AdminSession) => void }) {
  const [token] = useState(() => readAndClearInvitationToken(window.location, window.history));
  const [mode, setMode] = useState<Mode>("existing");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [currentSession, setCurrentSession] = useState<AdminSession | null>(null);
  const [sessionChecking, setSessionChecking] = useState(Boolean(token));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void api.admin.auth.session().then((session) => {
      if (active) setCurrentSession(session);
    }).catch((caught) => {
      if (active && !(isApiError(caught) && (caught.status === 401 || caught.status === 403))) setError(caught);
    }).finally(() => { if (active) setSessionChecking(false) });
    return () => { active = false };
  }, [token]);

  function finish(session: AdminSession) {
    window.history.replaceState(window.history.state, "", "/admin/");
    onAccepted(session);
  }

  function selectMode(nextMode: Mode) {
    setMode(nextMode);
    setError(null);
    document.getElementById(`invitation-${nextMode}-tab`)?.focus();
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectMode(event.key === "ArrowLeft" || event.key === "Home" ? "existing" : "new");
  }

  async function acceptExisting(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setLoading(true); setError(null);
    try {
      finish(await acceptInvitationForExistingUser({ api: api.invitations, token, currentSession, email: email.trim(), password }));
    } catch (caught) { setError(caught) } finally { setLoading(false) }
  }

  async function acceptNew(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setLoading(true); setError(null);
    try {
      finish(await api.invitations.acceptNewUser({ token, name: name.trim(), password: newPassword }));
    } catch (caught) { setError(caught) } finally { setLoading(false) }
  }

  return (
    <main className="auth-layout invitation-layout">
      <section className="auth-story">
        <div className="brand-mark"><KeyRound className="size-6" /></div>
        <p className="eyebrow">团队协作邀请</p>
        <h1>加入 LicenKit 实例。</h1>
        <p>安全邀请凭证已就绪。请确认你的管理员账号或创建新账号以加入当前实例。</p>
        <div className="auth-principles">
          <span><ShieldCheck className="size-4" /> 邀请人无法代设或查看你的登录密码</span>
          <span><ShieldCheck className="size-4" /> 已有账号可直接安全关联验证</span>
          <span><ShieldCheck className="size-4" /> 邀请凭证仅在当前安全会话中有效</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
            <div>
              <p className="eyebrow">接受邀请</p>
              <h2>确认你的账号身份</h2>
              <p>若已有本系统管理员账号请直接登录；首次使用请注册新账号。</p>
            </div>
            <LanguageSwitcher />
          </div>
          {!token ? <Notice tone="warning"><strong>邀请链接无效或凭证已丢失。</strong><p>未检测到有效的邀请凭证。请从收到的邀请邮件中重新点击打开链接。</p></Notice> : null}
          <ErrorPanel error={error} />
          <div className="tabs" role="tablist" aria-label="接受邀请方式">
            <button id="invitation-existing-tab" type="button" role="tab" aria-selected={mode === "existing"} aria-controls="invitation-existing-panel" tabIndex={mode === "existing" ? 0 : -1} className={mode === "existing" ? "active" : ""} onKeyDown={handleTabKey} onClick={() => selectMode("existing")}>已有账号登录</button>
            <button id="invitation-new-tab" type="button" role="tab" aria-selected={mode === "new"} aria-controls="invitation-new-panel" tabIndex={mode === "new" ? 0 : -1} className={mode === "new" ? "active" : ""} onKeyDown={handleTabKey} onClick={() => selectMode("new")}>注册新账号</button>
          </div>
          {mode === "existing" ? (
            <form id="invitation-existing-panel" role="tabpanel" aria-labelledby="invitation-existing-tab" className="form-stack" onSubmit={acceptExisting}>
              {sessionChecking ? <div className="state-panel compact-state"><Loader2 className="size-4 animate-spin" /><span>正在检查当前登录状态</span></div> : currentSession ? (
                <Notice tone="success"><strong>当前已登录：{currentSession.user.name}</strong><p>{currentSession.user.email} · 当前所在实例：{currentSession.instance.name}。确认后将直接加入新实例。</p></Notice>
              ) : (
                <>
                  <Field label="管理员邮箱"><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required disabled={!token} /></Field>
                  <Field label="密码"><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={!token} /></Field>
                </>
              )}
              <Button className="w-full" type="submit" loading={loading} disabled={!token || sessionChecking}>{currentSession ? "使用当前账号加入实例" : "验证身份并加入实例"} <ArrowRight className="size-4" /></Button>
            </form>
          ) : (
            <form id="invitation-new-panel" role="tabpanel" aria-labelledby="invitation-new-tab" className="form-stack" onSubmit={acceptNew}>
              <Field label="管理员姓名"><Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" placeholder="例如：Alex" required disabled={!token} /></Field>
              <Field label="设置登录密码" hint="长度不少于 12 位，建议混合大小写字母与数字"><Input type="password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required disabled={!token} /></Field>
              <Button className="w-full" type="submit" loading={loading} disabled={!token}>创建账号并加入实例 <UserPlus className="size-4" /></Button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
