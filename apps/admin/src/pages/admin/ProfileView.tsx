import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Languages, RefreshCw, UserRound } from "lucide-react";
import { api, type User } from "../../lib/api-client";
import {
  Button,
  Card,
  ErrorPanel,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
} from "../../components/ui";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { SupportedLocale } from "../../lib/i18n/types";

export function ProfileView({
  initialUser,
  onUserUpdated,
}: {
  initialUser: User;
  onUserUpdated: (user: User) => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const [user, setUser] = useState(initialUser);
  const [name, setName] = useState(initialUser.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<"profile" | "password" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.admin.profile.get();
      setUser(result);
      setName(result.name);
      onUserUpdated(result);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setSaving("profile");
    setError(null);
    setMessage(null);
    try {
      const result = await api.admin.profile.update(name.trim());
      setUser(result);
      setName(result.name);
      onUserUpdated(result);
      setMessage(t.settings.profileSaved);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(null);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setSaving("password");
    setError(null);
    setMessage(null);
    try {
      await api.admin.profile.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setMessage(t.settings.passwordChanged);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.settings.profileEyebrow}
        title={t.settings.profileTitle}
        description={t.settings.profileDescription}
        action={
          <Button variant="secondary" loading={loading} onClick={() => void load()}>
            <RefreshCw className="size-4" />
            {t.common.refresh}
          </Button>
        }
      />
      <ErrorPanel error={error} onClose={() => setError(null)} />
      {message ? (
        <Notice tone="success">
          <strong>{message}</strong>
        </Notice>
      ) : null}

      <div className="two-column">
        <Card>
          <div className="card-header">
            <div>
              <p className="eyebrow">{t.settings.basicInfoTitle}</p>
              <h2>{t.settings.basicInfoTitle}</h2>
              <p>{t.settings.basicInfoSubtitle}</p>
            </div>
            <UserRound className="size-5" />
          </div>
          <form className="form-stack" onSubmit={saveProfile}>
            <Field label={t.settings.nameLabel}>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                required
              />
            </Field>
            <Field label={t.settings.emailLabel} hint={t.settings.emailHint}>
              <Input type="email" value={user.email} readOnly disabled />
            </Field>
            <div className="form-actions">
              <Button type="submit" loading={saving === "profile"}>
                {t.settings.saveProfile}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <div className="card-header">
            <div>
              <p className="eyebrow">{t.settings.languageTitle}</p>
              <h2>{t.settings.languageLabel}</h2>
              <p>{t.settings.languageDescription}</p>
            </div>
            <Languages className="size-5" />
          </div>
          <div className="form-stack">
            <Field label={t.settings.languageLabel}>
              <Select
                value={locale}
                onChange={(event) => {
                  const nextLocale = event.target.value as SupportedLocale;
                  setLocale(nextLocale);
                  setMessage(t.settings.languageSaved);
                }}
              >
                <option value="zh-CN">{t.settings.options.zhCN}</option>
                <option value="en-US">{t.settings.options.enUS}</option>
              </Select>
            </Field>
          </div>
        </Card>
      </div>

      <Card>
        <div className="card-header">
          <div>
            <p className="eyebrow">{t.settings.passwordTitle}</p>
            <h2>{t.settings.passwordTitle}</h2>
            <p>{t.settings.passwordSubtitle}</p>
          </div>
          <KeyRound className="size-5" />
        </div>
        <form className="form-stack" onSubmit={changePassword}>
          <div className="form-grid">
            <Field label={t.settings.currentPasswordLabel}>
              <Input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            <Field label={t.settings.newPasswordLabel} hint={t.settings.newPasswordHint}>
              <Input
                type="password"
                minLength={12}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button type="submit" loading={saving === "password"}>
              {t.settings.changePassword}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
