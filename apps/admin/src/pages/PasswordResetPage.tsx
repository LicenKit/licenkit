import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { api, isApiError } from "../lib/api-client";
import { passwordResetTokenFromFragment } from "../lib/password-reset-fragment";
import { useI18n } from "../lib/i18n/I18nContext";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { Turnstile } from "../components/Turnstile";
import { Button, Field, Input, Notice } from "../components/ui";

export function PasswordResetPage() {
  const { t } = useI18n();
  const text = t.passwordReset;
  const resetting = window.location.pathname === "/admin/reset-password";
  // Reading is pure: StrictMode may call initializers twice before effects run.
  const [token, setToken] = useState(() => resetting ? passwordResetTokenFromFragment(window.location.hash) : null);
  const [invalid, setInvalid] = useState(resetting && !token);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [config, setConfig] = useState<{ turnstileSiteKey: string; turnstileAction: string } | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const [verificationError, setVerificationError] = useState(false);

  // Remove the secret before loading any external verification script.
  useEffect(() => {
    window.history.replaceState(window.history.state, "", window.location.pathname);
    if (!resetting) return;
    const receiveLink = () => {
      const nextToken = passwordResetTokenFromFragment(window.location.hash);
      window.history.replaceState(window.history.state, "", window.location.pathname);
      setToken(nextToken); setInvalid(!nextToken); setDone(false); setError(null);
      setPassword(""); setConfirmation(""); setPasswordMismatch(false);
    };
    window.addEventListener("hashchange", receiveLink);
    return () => window.removeEventListener("hashchange", receiveLink);
  }, [resetting]);

  const loadConfiguration = useCallback(async () => {
    setLoading(true); setError(null); setVerificationError(false);
    try { setConfig(await api.admin.auth.passwordResetConfig()) }
    catch (caught) { setError(caught) }
    finally { setLoading(false) }
  }, []);

  useEffect(() => { if (!resetting) void loadConfiguration() }, [resetting, loadConfiguration]);
  const verificationFailed = useCallback(() => { setVerificationError(true) }, []);

  async function submitRequest(event: FormEvent) {
    event.preventDefault();
    if (!turnstileToken) return;
    setLoading(true); setError(null);
    try {
      await api.admin.auth.requestPasswordReset({ email: email.trim(), turnstileToken });
      setAccepted(true);
    } catch (caught) { setError(caught) }
    finally { setTurnstileToken(""); setVerificationAttempt((value) => value + 1); setLoading(false) }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    if (password !== confirmation) { setPasswordMismatch(true); return }
    setPasswordMismatch(false);
    setLoading(true); setError(null);
    try {
      await api.admin.auth.resetPassword({ token, newPassword: password });
      setToken(null); setPassword(""); setConfirmation(""); setDone(true);
    } catch (caught) {
      if (isApiError(caught) && caught.code === "PASSWORD_RESET_LINK_INVALID") { setInvalid(true); setToken(null) }
      else setError(caught);
    } finally { setLoading(false) }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="brand-mark"><KeyRound className="size-6" /></div>
        <p className="eyebrow">LicenKit</p>
        <h1>{resetting ? text.resetTitle : text.requestTitle}</h1>
        <p>{resetting ? text.resetDescription : text.requestDescription}</p>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="card-header"><div><h2>{resetting ? text.resetTitle : text.requestTitle}</h2><p>{resetting ? text.resetDescription : text.requestDescription}</p></div><LanguageSwitcher /></div>
          {error ? <Notice tone="warning"><p role="alert">{isApiError(error) ? (t.errors[error.code] ?? t.common.requestFailed) : t.common.requestFailed}</p></Notice> : null}
          {done ? <Notice tone="success"><strong>{text.successTitle}</strong><p>{text.successDescription}</p></Notice>
          : invalid ? <Notice tone="warning"><p>{text.invalidLink}</p></Notice>
          : resetting ? (
            <form className="form-stack" onSubmit={submitPassword}>
              <Field label={text.newPassword} hint={text.passwordHint}>
                <Input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={password} onChange={(event) => setPassword(event.target.value)} />
              </Field>
              <Field label={text.confirmPassword} error={passwordMismatch ? text.passwordMismatch : undefined}>
                <Input type="password" autoComplete="new-password" minLength={12} maxLength={256} required aria-invalid={passwordMismatch} value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setPasswordMismatch(false) }} />
              </Field>
              <Button type="submit" loading={loading}>{text.resetButton}</Button>
            </form>
          ) : accepted ? (
            <Notice tone="success"><strong>{text.acceptedTitle}</strong><p>{text.acceptedDescription}</p></Notice>
          ) : (
            <form className="form-stack" onSubmit={submitRequest}>
              <Field label={t.auth.emailLabel}><Input type="email" autoComplete="username" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
              {config ? <Turnstile key={verificationAttempt} siteKey={config.turnstileSiteKey} action={config.turnstileAction} onToken={setTurnstileToken} onError={verificationFailed} /> : loading ? <p role="status">{text.verificationLoading}</p> : null}
              {verificationError ? <Notice tone="warning"><p>{text.verificationFailed}</p></Notice> : null}
              <Button type="submit" loading={loading} disabled={!config || !turnstileToken}>{text.requestButton}</Button>
              {error || verificationError ? <Button type="button" variant="secondary" onClick={() => { setTurnstileToken(""); setVerificationAttempt((value) => value + 1); void loadConfiguration() }}>{t.common.retry}</Button> : null}
            </form>
          )}
          {invalid || accepted ? <a href="/admin/forgot-password">{text.requestAgain}</a> : null}
          {!done ? <a href="/admin/recover-password">{t.recoveryCredential.useCredential}</a> : null}
          <a href="/admin/">{text.backToLogin}</a>
        </div>
      </section>
    </main>
  );
}
