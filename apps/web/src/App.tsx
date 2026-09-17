import { useState, useEffect } from "react";
import { api } from "./lib/api-client";
import { SetupPage } from "./pages/SetupPage";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { Loader2 } from "lucide-react";

export function App() {
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [user, setUser] = useState<any>(null);
  const [account, setAccount] = useState<any>(null);

  useEffect(() => {
    checkSystemStatus();
  }, []);

  const checkSystemStatus = async () => {
    try {
      setLoading(true);
      const status = await api.system.getStatus();
      setInitialized(status.initialized);

      if (status.initialized) {
        const token = localStorage.getItem("licenkit_token");
        if (token) {
          try {
            const me = await api.auth.me();
            setUser(me.user);
            setAccount(me.account);
          } catch {
            localStorage.removeItem("licenkit_token");
          }
        }
      }
    } catch (err) {
      console.error("Failed to connect to LicenKit server:", err);
      setInitialized(false);
    } finally {
      setLoading(false);
    }
  };

  const handleSetupOrLoginSuccess = (_token: string, newUser: any, newAccount: any) => {
    setUser(newUser);
    setAccount(newAccount);
    setInitialized(true);
  };

  const handleLogout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // ignore
    }
    localStorage.removeItem("licenkit_token");
    setUser(null);
    setAccount(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-slate-400 gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        <span className="text-sm font-medium">Connecting to LicenKit...</span>
      </div>
    );
  }

  // Not yet initialized -> Show First-time Setup Wizard
  if (!initialized) {
    return <SetupPage onSetupSuccess={handleSetupOrLoginSuccess} />;
  }

  // Initialized, but not logged in -> Show Login Page
  if (!user || !account) {
    return <LoginPage onLoginSuccess={handleSetupOrLoginSuccess} />;
  }

  // Fully authenticated -> Dashboard
  return <DashboardPage user={user} account={account} onLogout={handleLogout} />;
}

export default App;
