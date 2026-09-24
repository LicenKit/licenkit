import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, KeyRound, Loader2, ShieldCheck, UserPlus } from "lucide-react";
import { api, isApiError, type AdminSession } from "../lib/api-client";
import { acceptInvitationForExistingUser } from "../lib/invitation-acceptance";
import { readAndClearInvitationToken } from "../lib/invitation-fragment";
import { Button, ErrorPanel, Field, Input, Notice } from "../components/ui";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { useI18n } from "../lib/i18n/I18nContext";

type Mode = "existing" | "new";

export function InvitationAcceptPage({ onAccepted }: { onAccepted: (session: AdminSession) => void }) {
  const { t } = useI18n();
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

  const i18n = t.invitationAccept;

  return (
    <main className="auth-layout invitation-layout">
      <section className="auth-story">
        <div className="brand-mark"><KeyRound className="size-6" /></div>
        <p className="eyebrow">{i18n.storyEyebrow}</p>
        <h1>{i18n.storyTitle}</h1>
        <p>{i18n.storyDescription}</p>
        <div className="auth-principles">
          <span><ShieldCheck className="size-4" /> {i18n.principleNoPassword}</span>
          <span><ShieldCheck className="size-4" /> {i18n.principleExistingAccount}</span>
          <span><ShieldCheck className="size-4" /> {i18n.principleSessionScoped}</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
            <div>
              <p className="eyebrow">{i18n.acceptEyebrow}</p>
              <h2>{i18n.acceptTitle}</h2>
              <p>{i18n.acceptDescription}</p>
            </div>
            <LanguageSwitcher />
          </div>
          {!token ? (
            <Notice tone="warning">
              <strong>{i18n.invalidTokenTitle}</strong>
              <p>{i18n.invalidTokenBody}</p>
            </Notice>
          ) : null}
          <ErrorPanel error={error} onClose={() => setError(null)} floating={false} />
          <div className="tabs" role="tablist" aria-label={i18n.tabListAria}>
            <button id="invitation-existing-tab" type="button" role="tab" aria-selected={mode === "existing"} aria-controls="invitation-existing-panel" tabIndex={mode === "existing" ? 0 : -1} className={mode === "existing" ? "active" : ""} onKeyDown={handleTabKey} onClick={() => selectMode("existing")}>{i18n.tabExisting}</button>
            <button id="invitation-new-tab" type="button" role="tab" aria-selected={mode === "new"} aria-controls="invitation-new-panel" tabIndex={mode === "new" ? 0 : -1} className={mode === "new" ? "active" : ""} onKeyDown={handleTabKey} onClick={() => selectMode("new")}>{i18n.tabNew}</button>
          </div>
          {mode === "existing" ? (
            <form id="invitation-existing-panel" role="tabpanel" aria-labelledby="invitation-existing-tab" className="form-stack" onSubmit={acceptExisting}>
              {sessionChecking ? <div className="state-panel compact-state"><Loader2 className="size-4 animate-spin" /><span>{i18n.sessionChecking}</span></div> : currentSession ? (
                <Notice tone="success">
                  <strong>{i18n.loggedInNoticeTitle(currentSession.user.name)}</strong>
                  <p>{i18n.loggedInNoticeBody(currentSession.user.email, currentSession.instance.name)}</p>
                </Notice>
              ) : (
                <>
                  <Field label={i18n.emailLabel}><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required disabled={!token} /></Field>
                  <Field label={i18n.passwordLabel}><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={!token} /></Field>
                </>
              )}
              <Button className="w-full" type="submit" loading={loading} disabled={!token || sessionChecking}>
                {currentSession ? i18n.btnJoinWithCurrent : i18n.btnVerifyAndJoin} <ArrowRight className="size-4" />
              </Button>
            </form>
          ) : (
            <form id="invitation-new-panel" role="tabpanel" aria-labelledby="invitation-new-tab" className="form-stack" onSubmit={acceptNew}>
              <Field label={i18n.nameLabel}><Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" placeholder={i18n.namePlaceholder} required disabled={!token} /></Field>
              <Field label={i18n.newPasswordLabel} hint={i18n.newPasswordHint}><Input type="password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required disabled={!token} /></Field>
              <Button className="w-full" type="submit" loading={loading} disabled={!token}>
                {i18n.btnCreateAndJoin} <UserPlus className="size-4" />
              </Button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
