import { useState, type FormEvent, type ChangeEvent } from "react";
import { KeyRound } from "lucide-react";
import { api, isApiError } from "../lib/api-client";
import { useI18n } from "../lib/i18n/I18nContext";
import { parseRecoveryCredentialFile, type RecoveryCredentialFile } from "../lib/recovery-credential-file";
import { RecoveryCredentialDialog } from "../components/RecoveryCredentialDialog";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { Button, Field, Input, Notice } from "../components/ui";

export function RecoveryPasswordPage() {
  const { t } = useI18n();
  const text = t.recoveryCredential;
  const [email, setEmail] = useState("");
  const [credential, setCredential] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const [fileError, setFileError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [replacement, setReplacement] = useState<RecoveryCredentialFile | null>(null);

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileError(false);
    try {
      if (file.size > 8192) { setFileError(true); return }
      const parsed = parseRecoveryCredentialFile(await file.text());
      if (!parsed) { setFileError(true); return }
      setEmail(parsed.email); setCredential(parsed.credential);
    } catch { setFileError(true) }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirmation) { setPasswordMismatch(true); return }
    setLoading(true); setError(null); setPasswordMismatch(false);
    try {
      const result = await api.admin.auth.recoverPassword({ email: email.trim(), recoveryCredential: credential.trim(), newPassword: password });
      setCredential(""); setPassword(""); setConfirmation(""); setDone(true);
      setReplacement({ email: email.trim().toLowerCase(), credential: result.recoveryCredential, adminUrl: window.location.origin });
    } catch (caught) { setError(caught) }
    finally { setLoading(false) }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="brand-mark"><KeyRound className="size-6" /></div>
        <p className="eyebrow">LicenKit</p><h1>{text.recoverTitle}</h1><p>{text.recoverDescription}</p>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="card-header"><div><h2>{text.recoverTitle}</h2><p>{text.recoverDescription}</p></div><LanguageSwitcher /></div>
          {error ? <Notice tone="warning"><p role="alert">{isApiError(error) ? (t.errors[error.code] ?? t.common.requestFailed) : t.common.requestFailed}</p></Notice> : null}
          {done ? <Notice tone="success"><strong>{t.passwordReset.successTitle}</strong><p>{t.passwordReset.successDescription}</p></Notice> : (
            <form className="form-stack" onSubmit={submit}>
              <Field label={text.uploadLabel} error={fileError ? text.fileInvalid : undefined}><Input type="file" accept=".txt,text/plain" onChange={(event) => void importFile(event)} /></Field>
              <Field label={t.auth.emailLabel}><Input type="email" autoComplete="username" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
              <Field label={text.credentialLabel}><Input type="password" autoComplete="off" required maxLength={68} pattern="rcv_[0-9a-f]{64}" value={credential} onChange={(event) => setCredential(event.target.value)} /></Field>
              <Field label={t.passwordReset.newPassword} hint={t.passwordReset.passwordHint}><Input type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
              <Field label={t.passwordReset.confirmPassword} error={passwordMismatch ? t.passwordReset.passwordMismatch : undefined}><Input type="password" autoComplete="new-password" required minLength={12} maxLength={256} aria-invalid={passwordMismatch} value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setPasswordMismatch(false) }} /></Field>
              <Button type="submit" loading={loading}>{t.passwordReset.resetButton}</Button>
            </form>
          )}
          {!done ? <a href="/admin/forgot-password">{t.auth.forgotPassword}</a> : null}
          <a href="/admin/">{t.passwordReset.backToLogin}</a>
        </div>
      </section>
      {replacement ? <RecoveryCredentialDialog file={replacement} onClose={() => setReplacement(null)} /> : null}
    </main>
  );
}
