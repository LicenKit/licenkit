import { useState } from "react";
import type { FormEvent, ChangeEvent } from "react";
import { api } from "../lib/api-client";
import { KeyRound, ShieldCheck, ArrowRight, Globe, Building2, User } from "lucide-react";

interface SetupPageProps {
  onSetupSuccess: (token: string, user: any, account: any) => void;
}

export const SetupPage: React.FC<SetupPageProps> = ({ onSetupSuccess }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    instance_name: "My Licensing Hub",
    app_url: window.location.origin,
    api_base_url: "",
    account_name: "Default Team",
    slug: "default",
    admin_name: "Admin",
    admin_email: "",
    admin_password: "",
  });

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const payload = {
        ...formData,
        api_base_url: formData.api_base_url.trim() ? formData.api_base_url.trim() : null,
      };

      const res = await api.system.setup(payload);
      localStorage.setItem("licenkit_token", res.session_token);
      onSetupSuccess(res.session_token, res.user, res.account);
    } catch (err: any) {
      setError(err.message || "Failed to initialize instance");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-xl">
        <div className="flex justify-center items-center gap-3 mb-2">
          <div className="h-12 w-12 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-400">
            <KeyRound className="w-6 h-6" />
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">LicenKit</h1>
        </div>
        <p className="text-center text-sm text-indigo-200">
          Welcome! Complete this one-time setup wizard to initialize your licensing engine.
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-xl">
        <div className="bg-slate-800/90 backdrop-blur-md border border-slate-700/80 py-8 px-6 shadow-2xl rounded-2xl sm:px-10 text-white">
          {error && (
            <div className="mb-6 bg-red-500/10 border border-red-500/30 text-red-300 p-3.5 rounded-lg text-sm flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-red-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Section 1: System & Domains */}
            <div>
              <div className="flex items-center gap-2 text-indigo-400 font-semibold mb-3 border-b border-slate-700/60 pb-2">
                <Globe className="w-4 h-4" />
                <span className="text-sm uppercase tracking-wider">1. System & Domain Configuration</span>
              </div>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Instance Name</label>
                  <input
                    type="text"
                    name="instance_name"
                    required
                    value={formData.instance_name}
                    onChange={handleChange}
                    className="w-full bg-slate-900/80 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                    placeholder="e.g., ScreenStudio Hub"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">App URL (Dashboard Origin)</label>
                  <input
                    type="url"
                    name="app_url"
                    required
                    value={formData.app_url}
                    onChange={handleChange}
                    className="w-full bg-slate-900/80 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                    placeholder="https://license.yourdomain.com"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    API Base URL <span className="text-slate-500 font-normal">(Optional - defaults to App URL/api/v1)</span>
                  </label>
                  <input
                    type="url"
                    name="api_base_url"
                    value={formData.api_base_url}
                    onChange={handleChange}
                    className="w-full bg-slate-900/80 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                    placeholder="Leave empty for single-domain zero-CORS deployment"
                  />
                </div>
              </div>
            </div>

            {/* Section 2: Account Space */}
            <div>
              <div className="flex items-center gap-2 text-indigo-400 font-semibold mb-3 border-b border-slate-700/60 pb-2">
                <Building2 className="w-4 h-4" />
                <span className="text-sm uppercase tracking-wider">2. Workspace Organization</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Team / Org Name</label>
                  <input
                    type="text"
                    name="account_name"
                    required
                    value={formData.account_name}
                    onChange={handleChange}
                    className="w-full bg-slate-900/80 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Slug (Identifier)</label>
                  <input
                    type="text"
                    name="slug"
                    required
                    value={formData.slug}
                    onChange={handleChange}
                    className="w-full bg-slate-900/80 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>

            {/* Section 3: Owner Admin User */}
            <div>
              <div className="flex items-center gap-2 text-indigo-400 font-semibold mb-3 border-b border-slate-700/60 pb-2">
                <User className="w-4 h-4" />
                <span className="text-sm uppercase tracking-wider">3. Initial Owner Credentials</span>
              </div>
              <div className="grid grid-cols-1 gap-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Admin Name</label>
                    <input
                      type="text"
                      name="admin_name"
                      required
                      value={formData.admin_name}
                      onChange={handleChange}
                      className="w-full bg-slate-900/80 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Admin Email</label>
                    <input
                      type="email"
                      name="admin_email"
                      required
                      value={formData.admin_email}
                      onChange={handleChange}
                      className="w-full bg-slate-900/80 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                      placeholder="admin@example.com"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Master Password (min 8 chars)</label>
                  <input
                    type="password"
                    name="admin_password"
                    required
                    minLength={8}
                    value={formData.admin_password}
                    onChange={handleChange}
                    className="w-full bg-slate-900/80 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                    placeholder="••••••••••••"
                  />
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-4 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2.5 px-4 rounded-lg transition-colors shadow-lg shadow-indigo-600/30"
            >
              {loading ? (
                "Initializing Instance..."
              ) : (
                <>
                  <span>Complete Setup & Launch Dashboard</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
