import { useEffect, useState } from "react";
import { Loader2, RefreshCw, ServerCrash } from "lucide-react";
import { api, isApiError, type AdminSession } from "./lib/api-client";
import { Button, ErrorPanel } from "./components/ui";
import { SetupPage } from "./pages/SetupPage";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { InvitationAcceptPage } from "./pages/InvitationAcceptPage";

export function App() {
  const invitationPath = window.location.pathname === "/admin/invitations/accept";
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [session, setSession] = useState<AdminSession | null>(null);
  const [bootstrapError, setBootstrapError] = useState<unknown>(null);

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

  useEffect(() => { if (!invitationPath) void bootstrap() }, [invitationPath]);

  if (invitationPath) return <InvitationAcceptPage onAccepted={(accepted) => { setSession(accepted); setInitialized(true); setLoading(false) }} />;

  if (loading) {
    return <main className="centered-page"><div className="loading-brand"><span className="brand-mark"><Loader2 className="size-6 animate-spin" /></span><strong>正在连接 LicenKit</strong><span>正在检查系统初始化状态与安全会话...</span></div></main>;
  }

  if (bootstrapError || initialized === null) {
    return <main className="centered-page"><section className="connection-error card"><ServerCrash className="size-8" /><h1>无法连接到服务端</h1><p>未能与 LicenKit 后端建立安全连接，请检查服务运行状态或网络连接后重试。</p><ErrorPanel error={bootstrapError} /><Button onClick={() => void bootstrap()}><RefreshCw className="size-4" />重新连接</Button></section></main>;
  }

  if (!initialized) return <SetupPage onSetupSuccess={(result) => { setSession(result); setInitialized(true) }} />;
  if (!session) return <LoginPage onLoginSuccess={setSession} />;

  return <DashboardPage session={session} onSessionChange={setSession} onLogout={() => {
    void api.admin.auth.logout().then(() => setSession(null)).catch(setBootstrapError);
  }} />;
}

export default App;
