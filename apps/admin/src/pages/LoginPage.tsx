import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { api, type AdminSession } from "../lib/api-client";
import { Button, ErrorPanel, Field, Input } from "../components/ui";
import { useI18n } from "../lib/i18n/I18nContext";
import { LanguageSwitcher } from "../components/LanguageSwitcher";

export function LoginPage({ onLoginSuccess }: { onLoginSuccess: (session: AdminSession) => void }) {
  const { t } = useI18n();
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
        <div className="brand-mark">
          <KeyRound className="size-6" />
        </div>
        <p className="eyebrow">LicenKit</p>
        <h1>{t.auth.brandTagline}</h1>
        <p>{t.auth.brandDescription}</p>
        <div className="auth-principles">
          <span>
            <ShieldCheck className="size-4" /> {t.auth.principleIsolation}
          </span>
          <span>
            <ShieldCheck className="size-4" /> {t.auth.principleCrypto}
          </span>
          <span>
            <ShieldCheck className="size-4" /> {t.auth.principleFulfillment}
          </span>
        </div>
      </section>
      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
            <div>
              <p className="eyebrow">{t.auth.loginEyebrow}</p>
              <h2>{t.auth.loginTitle}</h2>
              <p>{t.auth.loginDescription}</p>
            </div>
            <LanguageSwitcher />
          </div>
          <ErrorPanel error={error} onClose={() => setError(null)} floating={false} />
          <Field label={t.auth.emailLabel}>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              placeholder="owner@example.com"
              required
            />
          </Field>
          <Field label={t.auth.passwordLabel}>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Button className="w-full" type="submit" loading={loading}>
            {t.auth.loginSubmit} <ArrowRight className="size-4" />
          </Button>
          <p className="auth-footnote">{t.auth.customerFootnote}</p>
        </form>
      </section>
    </main>
  );
}
