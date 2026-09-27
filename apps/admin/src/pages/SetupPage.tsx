import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Building2, KeyRound, LockKeyhole, UserRound } from "lucide-react";
import { api, type AdminSession } from "../lib/api-client";
import { nextSetupStep, previousSetupStep, type SetupStep } from "../lib/setup-flow";
import { Button, ErrorPanel, Field, Input, Notice } from "../components/ui";
import { useI18n } from "../lib/i18n/I18nContext";
import { LanguageSwitcher } from "../components/LanguageSwitcher";

const stepNumber: Record<SetupStep, number> = { token: 1, user: 2, instance: 3 };

function SetupLayout({
  step,
  title,
  description,
  children,
}: {
  step: SetupStep;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const { t } = useI18n();

  return (
    <main className="setup-layout setup-step-layout">
      <header className="setup-intro">
        <div className="brand-mark">
          <KeyRound className="size-6" />
        </div>
        <div className="setup-intro-body">
          <p className="eyebrow">{t.setup.eyebrow(stepNumber[step], 3)}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <LanguageSwitcher className="setup-lang-switcher" />
      </header>
      <div className="setup-progress" aria-label={`Setup ${stepNumber[step]} / 3`}>
        {(["token", "user", "instance"] as SetupStep[]).map((item) => (
          <span key={item} className={stepNumber[item] <= stepNumber[step] ? "active" : ""} />
        ))}
      </div>
      {children}
    </main>
  );
}

export function SetupPage({ onSetupSuccess }: { onSetupSuccess: (session: AdminSession) => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState<SetupStep>("token");
  const [setupToken, setSetupToken] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [password, setPassword] = useState("");
  const [instanceName, setInstanceName] = useState("");
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
      <SetupLayout step={step} title={t.setup.step1Title} description={t.setup.step1Description}>
        <form className="setup-card setup-card-compact" onSubmit={verifyToken}>
          <ErrorPanel error={error} onClose={() => setError(null)} floating={false} />
          <Notice tone="info">
            <strong>{t.setup.step1NoticeTitle}</strong>
            <p>{t.setup.step1NoticeBody}</p>
          </Notice>
          <div className="form-section">
            <div className="form-section-title">
              <LockKeyhole className="size-5" />
              <div>
                <h2>{t.setup.step1SectionTitle}</h2>
                <p>{t.setup.step1SectionSubtitle}</p>
              </div>
            </div>
            <Field label={t.setup.step1TokenLabel}>
              <Input
                type="password"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                autoComplete="off"
                placeholder={t.setup.step1TokenPlaceholder}
                required
                autoFocus
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button type="submit" loading={loading}>
              {t.setup.step1Submit} <ArrowRight className="size-4" />
            </Button>
          </div>
        </form>
      </SetupLayout>
    );
  }

  if (step === "user") {
    return (
      <SetupLayout step={step} title={t.setup.step2Title} description={t.setup.step2Description}>
        <form className="setup-card setup-card-compact" onSubmit={collectUser}>
          <ErrorPanel error={error} onClose={() => setError(null)} floating={false} />
          <div className="form-section">
            <div className="form-section-title">
              <UserRound className="size-5" />
              <div>
                <h2>{t.setup.step2SectionTitle}</h2>
                <p>{t.setup.step2SectionSubtitle}</p>
              </div>
            </div>
            <Field label={t.setup.step2NameLabel}>
              <Input
                value={ownerName}
                onChange={(event) => setOwnerName(event.target.value)}
                autoComplete="name"
                placeholder={t.setup.step2NamePlaceholder}
                required
                autoFocus
              />
            </Field>
            <Field label={t.setup.step2EmailLabel}>
              <Input
                type="email"
                value={ownerEmail}
                onChange={(event) => setOwnerEmail(event.target.value)}
                autoComplete="username"
                placeholder={t.setup.step2EmailPlaceholder}
                required
              />
            </Field>
            <Field label={t.setup.step2PasswordLabel} hint={t.setup.step2PasswordHint}>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                required
              />
            </Field>
          </div>
          <div className="form-actions split-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setError(null);
                setStep(previousSetupStep(step));
              }}
            >
              <ArrowLeft className="size-4" />
              {t.common.back}
            </Button>
            <Button type="submit">
              {t.setup.step2Submit} <ArrowRight className="size-4" />
            </Button>
          </div>
        </form>
      </SetupLayout>
    );
  }

  return (
    <SetupLayout step={step} title={t.setup.step3Title} description={t.setup.step3Description}>
      <form className="setup-card setup-card-compact" onSubmit={completeSetup}>
        <ErrorPanel error={error} onClose={() => setError(null)} floating={false} />
        <div className="form-section">
          <div className="form-section-title">
            <Building2 className="size-5" />
            <div>
              <h2>{t.setup.step3SectionTitle}</h2>
              <p>{t.setup.step3SectionSubtitle}</p>
            </div>
          </div>
          <Field label={t.setup.step3InstanceNameLabel}>
            <Input
              value={instanceName}
              onChange={(event) => setInstanceName(event.target.value)}
              placeholder={t.setup.step3InstanceNamePlaceholder}
              required
              autoFocus
            />
          </Field>
          <Field label={t.setup.step3AdminApiUrlLabel} hint={t.setup.step3AdminApiUrlHint}>
            <Input
              type="url"
              value={adminApiUrl}
              onChange={(event) => setAdminApiUrl(event.target.value)}
              placeholder={t.setup.step3AdminApiUrlPlaceholder}
              required
            />
          </Field>
          <Field label={t.setup.step3CustomerSiteUrlLabel} hint={t.setup.step3CustomerSiteUrlHint}>
            <Input
              type="url"
              value={customerSiteUrl}
              onChange={(event) => setCustomerSiteUrl(event.target.value)}
              placeholder={t.setup.step3CustomerSiteUrlPlaceholder}
              required
            />
          </Field>
        </div>
        <div className="form-actions split-actions">
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              setError(null);
              setStep(previousSetupStep(step));
            }}
          >
            <ArrowLeft className="size-4" />
            {t.common.back}
          </Button>
          <Button type="submit" loading={loading}>
            {t.setup.step3Submit} <ArrowRight className="size-4" />
          </Button>
        </div>
      </form>
    </SetupLayout>
  );
}
