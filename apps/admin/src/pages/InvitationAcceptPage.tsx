import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, KeyRound, Loader2, ShieldCheck, UserPlus } from "lucide-react";
import { api, isApiError, type AdminSession } from "../lib/api-client";
import { acceptInvitationForExistingUser } from "../lib/invitation-acceptance";
import { readAndClearInvitationToken } from "../lib/invitation-fragment";
import { Button, ErrorPanel, Field, Input, Notice } from "../components/ui";

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
        <p className="eyebrow">Instance Invitation</p>
        <h1>加入 LicenKit Instance。</h1>
        <p>邀请 Token 已从地址栏清除，只保存在当前页面内存。只有你明确提交后，页面才会通过 POST 接受邀请。</p>
        <div className="auth-principles">
          <span><ShieldCheck className="size-4" /> 邀请人不能替你设置或修改密码</span>
          <span><ShieldCheck className="size-4" /> 已有 User 先证明自己的身份</span>
          <span><ShieldCheck className="size-4" /> 刷新或离开页面后 Token 不再保留</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div><p className="eyebrow">接受邀请</p><h2>选择你的身份场景</h2><p>已有管理员 User 请选择登录；第一次使用请选择创建 User。</p></div>
          {!token ? <Notice tone="warning"><strong>邀请链接无效或已丢失 Token。</strong><p>请从原始邀请邮件重新打开链接；如果页面被刷新，请重新打开邮件中的链接。</p></Notice> : null}
          <ErrorPanel error={error} />
          <div className="tabs" role="tablist" aria-label="接受邀请方式">
            <button id="invitation-existing-tab" type="button" role="tab" aria-selected={mode === "existing"} aria-controls="invitation-existing-panel" tabIndex={mode === "existing" ? 0 : -1} className={mode === "existing" ? "active" : ""} onKeyDown={handleTabKey} onClick={() => selectMode("existing")}>已有 User</button>
            <button id="invitation-new-tab" type="button" role="tab" aria-selected={mode === "new"} aria-controls="invitation-new-panel" tabIndex={mode === "new" ? 0 : -1} className={mode === "new" ? "active" : ""} onKeyDown={handleTabKey} onClick={() => selectMode("new")}>创建 User</button>
          </div>
          {mode === "existing" ? (
            <form id="invitation-existing-panel" role="tabpanel" aria-labelledby="invitation-existing-tab" className="form-stack" onSubmit={acceptExisting}>
              {sessionChecking ? <div className="state-panel compact-state"><Loader2 className="size-4 animate-spin" /><span>正在检查当前管理员 Session</span></div> : currentSession ? (
                <Notice tone="success"><strong>当前已登录：{currentSession.user.name}</strong><p>{currentSession.user.email} · {currentSession.instance.name}。确认后才会通过 POST 接受邀请。</p></Notice>
              ) : (
                <>
                  <Field label="管理员邮箱"><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required disabled={!token} /></Field>
                  <Field label="密码"><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={!token} /></Field>
                </>
              )}
              <Button className="w-full" type="submit" loading={loading} disabled={!token || sessionChecking}>{currentSession ? "使用当前 Session 接受邀请" : "验证身份并接受邀请"} <ArrowRight className="size-4" /></Button>
            </form>
          ) : (
            <form id="invitation-new-panel" role="tabpanel" aria-labelledby="invitation-new-tab" className="form-stack" onSubmit={acceptNew}>
              <Field label="显示名称"><Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required disabled={!token} /></Field>
              <Field label="设置密码"><Input type="password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required disabled={!token} /></Field>
              <Button className="w-full" type="submit" loading={loading} disabled={!token}>创建 User 并接受邀请 <UserPlus className="size-4" /></Button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
