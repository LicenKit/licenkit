import { useEffect, useState } from "react";
import { Loader2, RefreshCw, ServerCrash } from "lucide-react";
import { api, isApiError, type AdminSession } from "./lib/api-client";
import { Button, ErrorPanel } from "./components/ui";
import { useI18n } from "./lib/i18n/I18nContext";
import { SetupPage } from "./pages/SetupPage";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { InvitationAcceptPage } from "./pages/InvitationAcceptPage";
import { PasswordResetPage } from "./pages/PasswordResetPage";
import { RecoveryCredentialDialog } from "./components/RecoveryCredentialDialog";
import type { RecoveryCredentialFile } from "./lib/recovery-credential-file";
import { RecoveryPasswordPage } from "./pages/RecoveryPasswordPage";

export function App() {
  const { t } = useI18n();
  const invitationPath = window.location.pathname === "/admin/invitations/accept";
  const passwordResetPath = ["/admin/forgot-password", "/admin/reset-password", "/admin/recover-password"].includes(window.location.pathname);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [session, setSession] = useState<AdminSession | null>(null);
  const [bootstrapError, setBootstrapError] = useState<unknown>(null);
  const [recoveryFile, setRecoveryFile] = useState<RecoveryCredentialFile | null>(null);

  function establishSession(result: AdminSession) {
    const { recoveryCredential, ...safeSession } = result;
    setSession(safeSession);
    if (recoveryCredential) setRecoveryFile({ credential: recoveryCredential, email: result.user.email, adminUrl: window.location.origin });
  }

  async function bootstrap() {
    setLoading(true);
    setBootstrapError(null);
    try {
      const status = await api.setup.status();
      setInitialized(status.initialized);
      if (status.initialized) {
        try {
          setSession(await api.admin.auth.session());
        } catch (caught) {
          if (isApiError(caught) && (caught.status === 401 || caught.status === 403)) setSession(null);
          else throw caught;
        }
      } else {
        setSession(null);
      }
    } catch (caught) {
      setBootstrapError(caught);
      setInitialized(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!invitationPath && !passwordResetPath) void bootstrap() }, [invitationPath, passwordResetPath]);

  if (passwordResetPath) return window.location.pathname === "/admin/recover-password" ? <RecoveryPasswordPage /> : <PasswordResetPage />;

  if (invitationPath) return <InvitationAcceptPage onAccepted={(accepted) => { establishSession(accepted); setInitialized(true); setLoading(false) }} />;

  if (loading) {
    return (
      <main className="centered-page">
        <div className="loading-brand">
          <span className="brand-mark"><Loader2 className="size-6 animate-spin" /></span>
          <strong>{t.auth.connectingBrand}</strong>
          <span>{t.auth.checkingSession}</span>
        </div>
      </main>
    );
  }

  if (bootstrapError || initialized === null) {
    return (
      <main className="centered-page">
        <section className="connection-error card">
          <ServerCrash className="size-8" />
          <h1>{t.auth.connectionFailedTitle}</h1>
          <p>{t.auth.connectionFailedDescription}</p>
          <ErrorPanel error={bootstrapError} floating={false} />
          <Button onClick={() => void bootstrap()}>
            <RefreshCw className="size-4" />{t.auth.reconnectButton}
          </Button>
        </section>
      </main>
    );
  }

  if (!initialized) return <SetupPage onSetupSuccess={(result) => { establishSession(result); setInitialized(true) }} />;
  if (!session) return <LoginPage onLoginSuccess={establishSession} />;

  return <><DashboardPage session={session} onSessionChange={setSession} onLogout={() => {
    void api.admin.auth.logout().then(() => setSession(null)).catch(setBootstrapError);
  }} />{recoveryFile ? <RecoveryCredentialDialog file={recoveryFile} onClose={() => setRecoveryFile(null)} /> : null}</>;
}

export default App;
