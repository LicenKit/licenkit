import React, { useState, useEffect } from "react";
import { api } from "../lib/api-client";
import {
  KeyRound,
  LayoutDashboard,
  Package,
  FileCheck2,
  Key,
  Webhook,
  Settings,
  Users,
  LogOut,
  Copy,
  Check,
  ShieldCheck,
  Plus,
  Monitor,
  Calendar,
  AlertTriangle,
  RotateCcw,
  Ban,
  Layers,
  Edit3,
  Search,
  Filter,
} from "lucide-react";
import { CreateProductModal } from "../components/modals/CreateProductModal";
import { CreatePolicyModal } from "../components/modals/CreatePolicyModal";
import { IssueLicenseModal } from "../components/modals/IssueLicenseModal";
import { EditProductModal } from "../components/modals/EditProductModal";
import { EditPolicyModal } from "../components/modals/EditPolicyModal";
import { LicenseDetailModal } from "../components/modals/LicenseDetailModal";

interface DashboardPageProps {
  user: any;
  account: any;
  onLogout: () => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ user, account, onLogout }) => {
  const [activeNav, setActiveNav] = useState<"overview" | "products" | "policies" | "licenses" | "gateways" | "settings" | "team">("overview");

  // Webhook & Gateway state
  const [paymentProvider, setPaymentProvider] = useState<"paddle" | "stripe" | "lemonsqueezy">("paddle");
  const [settingsData, setSettingsData] = useState<any>(null);
  const [webhookSecretInput, setWebhookSecretInput] = useState("");
  const [isSavingPayment, setIsSavingPayment] = useState(false);
  const [paymentSaveMessage, setPaymentSaveMessage] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Overview stats, products, policies, licenses
  const [stats, setStats] = useState({
    totalProducts: 0,
    totalLicenses: 0,
    activatedMachines: 0,
    expiringSoon: 0,
  });
  const [productsList, setProductsList] = useState<any[]>([]);
  const [policiesList, setPoliciesList] = useState<any[]>([]);
  const [licensesList, setLicensesList] = useState<any[]>([]);

  // Modal open states
  const [isCreateProductOpen, setIsCreateProductOpen] = useState(false);
  const [isCreatePolicyOpen, setIsCreatePolicyOpen] = useState(false);
  const [isIssueLicenseOpen, setIsIssueLicenseOpen] = useState(false);

  // Edit and Inspection states
  const [editingProduct, setEditingProduct] = useState<any | null>(null);
  const [isEditProductOpen, setIsEditProductOpen] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<any | null>(null);
  const [isEditPolicyOpen, setIsEditPolicyOpen] = useState(false);
  const [inspectingLicenseId, setInspectingLicenseId] = useState<string | null>(null);
  const [isLicenseDetailOpen, setIsLicenseDetailOpen] = useState(false);

  // License filter & search state
  const [licenseSearchQuery, setLicenseSearchQuery] = useState("");
  const [licenseProductFilter, setLicenseProductFilter] = useState("");
  const [licenseStatusFilter, setLicenseStatusFilter] = useState("all");

  // Copy tracking for keys inside tables/cards
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
    loadDashboardData();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await api.settings.get();
      setSettingsData(data);
    } catch (e) {
      console.error("Failed to load settings", e);
    }
  };

  const loadDashboardData = async () => {
    try {
      const [statsData, prods, pols, lics] = await Promise.all([
        api.stats.get().catch(() => ({
          totalProducts: 0,
          totalLicenses: 0,
          activatedMachines: 0,
          expiringSoon: 0,
        })),
        api.products.list().catch(() => ({ items: [] })),
        api.policies.list().catch(() => ({ items: [] })),
        api.licenses.list({
          page: 1,
          limit: 50,
          query: licenseSearchQuery.trim() || undefined,
          productId: licenseProductFilter || undefined,
          status: licenseStatusFilter !== "all" ? licenseStatusFilter : undefined,
        }).catch(() => ({ items: [] })),
      ]);
      setStats(statsData);
      setProductsList(prods.items || []);
      setPoliciesList(pols.items || []);
      setLicensesList(lics.items || []);
    } catch (e) {
      console.error("Failed to load dashboard data", e);
    }
  };

  const loadFilteredLicenses = async () => {
    try {
      const lics = await api.licenses.list({
        page: 1,
        limit: 50,
        query: licenseSearchQuery.trim() || undefined,
        product_id: licenseProductFilter || undefined,
        status: licenseStatusFilter !== "all" ? licenseStatusFilter : undefined,
      }).catch(() => ({ items: [] }));
      setLicensesList(lics.items || []);
    } catch (e) {
      console.error("Failed to load filtered licenses", e);
    }
  };

  useEffect(() => {
    loadFilteredLicenses();
  }, [licenseSearchQuery, licenseProductFilter, licenseStatusFilter]);

  const handleCopyText = (text: string, identifier: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(identifier);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleSuspendLicense = async (id: string) => {
    try {
      await api.licenses.suspend(id);
      loadDashboardData();
    } catch (e: any) {
      alert(e.message || "Failed to suspend license");
    }
  };

  const handleReinstateLicense = async (id: string) => {
    try {
      await api.licenses.reinstate(id);
      loadDashboardData();
    } catch (e: any) {
      alert(e.message || "Failed to reinstate license");
    }
  };

  const currentApiBase = settingsData?.system?.api_base_url || settingsData?.system?.app_url || window.location.origin;
  const webhookCallbackUrl = `${currentApiBase}/api/v1/webhooks/${paymentProvider}/${account.id}`;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const handleSavePaymentConfig = async () => {
    if (!webhookSecretInput.trim()) return;
    setIsSavingPayment(true);
    setPaymentSaveMessage(null);
    try {
      await api.settings.update({
        payment_configs: {
          [paymentProvider]: {
            enabled: true,
            webhook_secret: webhookSecretInput.trim(),
          },
        },
      });
      setWebhookSecretInput("");
      setPaymentSaveMessage("Webhook secret saved successfully!");
      await loadSettings();
      setTimeout(() => setPaymentSaveMessage(null), 3000);
    } catch (e: any) {
      alert(e.message || "Failed to save webhook secret");
    } finally {
      setIsSavingPayment(false);
    }
  };

  return (
    <div className="flex h-screen bg-slate-900 text-slate-100 overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 bg-slate-950/80 border-r border-slate-800 flex flex-col justify-between p-4 shrink-0">
        <div>
          {/* Logo & Brand */}
          <div className="flex items-center gap-3 px-3 py-3 mb-6">
            <div className="h-9 w-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <span className="font-bold text-base text-white tracking-wide block">LicenKit</span>
              <span className="text-xs text-slate-400 truncate block max-w-[140px]">{account.name}</span>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1">
            <button
              onClick={() => setActiveNav("overview")}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeNav === "overview" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              <span>Overview</span>
            </button>

            <button
              onClick={() => setActiveNav("products")}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeNav === "products" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <div className="flex items-center gap-3">
                <Package className="w-4 h-4" />
                <span>Products</span>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                {productsList.length}
              </span>
            </button>

            <button
              onClick={() => setActiveNav("policies")}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeNav === "policies" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <div className="flex items-center gap-3">
                <FileCheck2 className="w-4 h-4" />
                <span>Policies</span>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                {policiesList.length}
              </span>
            </button>

            <button
              onClick={() => setActiveNav("licenses")}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeNav === "licenses" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <div className="flex items-center gap-3">
                <Key className="w-4 h-4" />
                <span>Licenses</span>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                {licensesList.length}
              </span>
            </button>

            <button
              onClick={() => setActiveNav("gateways")}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeNav === "gateways" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Webhook className="w-4 h-4" />
              <span>Payment & Webhooks</span>
            </button>

            <button
              onClick={() => setActiveNav("settings")}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeNav === "settings" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Settings className="w-4 h-4" />
              <span>System Settings</span>
            </button>

            <button
              onClick={() => setActiveNav("team")}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeNav === "team" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Users className="w-4 h-4" />
              <span>Team & Access</span>
            </button>
          </nav>
        </div>

        {/* User Info & Logout */}
        <div className="pt-4 border-t border-slate-800/80">
          <div className="flex items-center justify-between px-2 py-1">
            <div className="overflow-hidden pr-2">
              <div className="text-sm font-medium text-white truncate">{user.name}</div>
              <div className="text-xs text-slate-400 truncate">{user.email}</div>
            </div>
            <button
              onClick={onLogout}
              title="Logout"
              className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Top bar */}
        <header className="h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm px-8 flex items-center justify-between sticky top-0 z-10">
          <h2 className="text-lg font-semibold text-white capitalize">
            {activeNav === "gateways" ? "Payment Gateways & Webhooks" : activeNav}
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              Cloudflare Worker Live
            </span>
          </div>
        </header>

        {/* Dynamic Tab Body */}
        <main className="p-8 flex-1">
          {/* 1. OVERVIEW TAB */}
          {activeNav === "overview" && (
            <div className="space-y-6">
              {/* Stat Cards */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-slate-800/50 border border-slate-700/60 p-5 rounded-xl">
                  <div className="text-xs font-medium text-slate-400 mb-1 uppercase tracking-wider">Active Products</div>
                  <div className="text-2xl font-bold text-white">{stats.totalProducts}</div>
                </div>
                <div className="bg-slate-800/50 border border-slate-700/60 p-5 rounded-xl">
                  <div className="text-xs font-medium text-slate-400 mb-1 uppercase tracking-wider">Total Licenses</div>
                  <div className="text-2xl font-bold text-white">{stats.totalLicenses}</div>
                </div>
                <div className="bg-slate-800/50 border border-slate-700/60 p-5 rounded-xl">
                  <div className="text-xs font-medium text-slate-400 mb-1 uppercase tracking-wider">Activated Machines</div>
                  <div className="text-2xl font-bold text-sky-400">{stats.activatedMachines}</div>
                </div>
                <div className="bg-slate-800/50 border border-slate-700/60 p-5 rounded-xl">
                  <div className="text-xs font-medium text-slate-400 mb-1 uppercase tracking-wider">Expiring Soon (30d)</div>
                  <div className="text-2xl font-bold text-amber-400">{stats.expiringSoon}</div>
                </div>
              </div>

              {/* Quick Launch Guide */}
              <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                <h3 className="text-base font-semibold text-white mb-2 flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-indigo-400" />
                  LicenKit Core Status
                </h3>
                <p className="text-sm text-slate-300 leading-relaxed mb-4">
                  Your self-hosted licensing engine is fully operational. Manage your software catalog, define seat limits,
                  issue licenses with asymmetric Ed25519 digital signatures, and automate order fulfillment with Paddle or Stripe.
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setIsCreateProductOpen(true)}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors shadow"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create Product</span>
                  </button>
                  <button
                    onClick={() => setIsIssueLicenseOpen(true)}
                    disabled={productsList.length === 0 || policiesList.length === 0}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-medium text-white rounded-lg transition-colors border border-slate-700"
                  >
                    <Key className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Issue License</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 2. PRODUCTS TAB */}
          {activeNav === "products" && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="text-base font-semibold text-white">Software Catalog</h3>
                  <p className="text-xs text-slate-400">Manage software products, trial durations, and Ed25519 public keys.</p>
                </div>
                <button
                  onClick={() => setIsCreateProductOpen(true)}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors shadow"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Product</span>
                </button>
              </div>

              {productsList.length === 0 ? (
                <div className="border border-dashed border-slate-800 rounded-2xl p-12 text-center">
                  <div className="w-12 h-12 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center mx-auto mb-3">
                    <Package className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-semibold text-white mb-1">No products created yet</h4>
                  <p className="text-xs text-slate-400 max-w-sm mx-auto mb-4">
                    Create your first product to generate an automatic Ed25519 cryptography signing key.
                  </p>
                  <button
                    onClick={() => setIsCreateProductOpen(true)}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors"
                  >
                    Create Product
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {productsList.map((p) => (
                    <div
                      key={p.id}
                      className="bg-slate-800/40 border border-slate-700/60 rounded-xl p-5 hover:border-slate-600 transition-colors flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-base text-white">{p.name}</span>
                            <button
                              onClick={() => handleCopyText(p.id, p.id)}
                              title="Copy Product ID"
                              className="text-[11px] text-slate-500 hover:text-slate-300 font-mono px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 flex items-center gap-1"
                            >
                              <span>{p.id}</span>
                              {copiedKey === p.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                            </button>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs px-2.5 py-0.5 rounded-full border ${
                                p.isActive
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                  : "bg-slate-700/30 text-slate-400 border-slate-700/40"
                              }`}
                            >
                              {p.isActive ? "Active" : "Inactive"}
                            </span>
                            <button
                              onClick={() => {
                                setEditingProduct(p);
                                setIsEditProductOpen(true);
                              }}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60 transition-colors"
                              title="Edit Product"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-slate-400 mb-4 line-clamp-2">
                          {p.description || "No product description provided."}
                        </p>

                        <div className="space-y-2 mb-4 text-xs">
                          <div className="flex items-center justify-between text-slate-300">
                            <span className="text-slate-400">Free Trial:</span>
                            <span>{(p.trialDays ?? 0) > 0 ? `${p.trialDays} Days` : "Disabled"}</span>
                          </div>
                          {p.trialFeatures && p.trialFeatures.length > 0 && (
                            <div className="flex items-center justify-between text-slate-300">
                              <span className="text-slate-400">Trial Features:</span>
                              <div className="flex gap-1 flex-wrap justify-end">
                                {p.trialFeatures.map((f: string) => (
                                  <span key={f} className="px-1.5 py-0.5 rounded bg-slate-700/60 text-[10px] text-slate-300">
                                    {f}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Ed25519 Public Key Box */}
                      {p.publicKey && (
                        <div className="pt-3 border-t border-slate-700/60">
                          <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                            <span className="flex items-center gap-1 text-indigo-300">
                              <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
                              Ed25519 Public Key
                            </span>
                            <button
                              onClick={() => handleCopyText(p.publicKey, p.id)}
                              className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                            >
                              {copiedKey === p.publicKey ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                              <span>{copiedKey === p.publicKey ? "Copied" : "Copy"}</span>
                            </button>
                          </div>
                          <div className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-[11px] text-slate-300 font-mono truncate select-all">
                            {p.publicKey}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 3. POLICIES TAB */}
          {activeNav === "policies" && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="text-base font-semibold text-white">Licensing Policies</h3>
                  <p className="text-xs text-slate-400">Configure machine seat limits, expiration intervals, and offline verification rules.</p>
                </div>
                <button
                  onClick={() => setIsCreatePolicyOpen(true)}
                  disabled={productsList.length === 0}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-medium text-white rounded-lg transition-colors shadow"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Policy</span>
                </button>
              </div>

              {policiesList.length === 0 ? (
                <div className="border border-dashed border-slate-800 rounded-2xl p-12 text-center">
                  <div className="w-12 h-12 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center mx-auto mb-3">
                    <FileCheck2 className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-semibold text-white mb-1">No policies defined yet</h4>
                  <p className="text-xs text-slate-400 max-w-sm mx-auto mb-4">
                    {productsList.length === 0
                      ? "Please create a product first before creating a policy."
                      : "Create a policy to define how many devices a customer can activate and license duration."}
                  </p>
                  <button
                    onClick={() => (productsList.length === 0 ? setIsCreateProductOpen(true) : setIsCreatePolicyOpen(true))}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors"
                  >
                    {productsList.length === 0 ? "Create Product First" : "Create Policy"}
                  </button>
                </div>
              ) : (
                <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-950/60 border-b border-slate-800 uppercase tracking-wider text-[11px] text-slate-400">
                      <tr>
                        <th className="py-3 px-4">Policy Name</th>
                        <th className="py-3 px-4">Product</th>
                        <th className="py-3 px-4">Duration</th>
                        <th className="py-3 px-4">Device Seats</th>
                        <th className="py-3 px-4">Offline Grace</th>
                        <th className="py-3 px-4">Scheme</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80">
                      {policiesList.map((pol) => (
                        <tr key={pol.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-white">{pol.name}</div>
                            {pol.features && pol.features.length > 0 && (
                              <div className="flex gap-1 flex-wrap mt-1">
                                {pol.features.map((f: string) => (
                                  <span key={f} className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">
                                    {f}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            <span className="px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                              {pol.productName || "Unknown"}
                            </span>
                          </td>
                          <td className="py-3.5 px-4">
                            {pol.duration ? `${Math.round(pol.duration / 86400)} Days` : "Perpetual (Lifetime)"}
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-1.5">
                              <Monitor className="w-3.5 h-3.5 text-slate-400" />
                              <span>{(pol.maxMachines ?? 1)} Seat{(pol.maxMachines ?? 1) > 1 ? "s" : ""}</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4">{Math.round((pol.offlineGracePeriod ?? 2592000) / 86400)} Days</td>
                          <td className="py-3.5 px-4">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                                pol.scheme === "ed25519"
                                  ? "bg-indigo-500/20 text-indigo-300"
                                  : "bg-purple-500/20 text-purple-300"
                              }`}
                            >
                              {pol.scheme}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <button
                              onClick={() => {
                                setEditingPolicy(pol);
                                setIsEditPolicyOpen(true);
                              }}
                              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] transition-colors border border-slate-700 inline-flex items-center gap-1"
                            >
                              <Edit3 className="w-3 h-3" />
                              <span>Edit</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 4. LICENSES TAB */}
          {activeNav === "licenses" && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="text-base font-semibold text-white">Issued Licenses</h3>
                  <p className="text-xs text-slate-400">Issue, audit, suspend, and reinstate customer activation keys.</p>
                </div>
                <button
                  onClick={() => setIsIssueLicenseOpen(true)}
                  disabled={productsList.length === 0 || policiesList.length === 0}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-medium text-white rounded-lg transition-colors shadow"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Issue License</span>
                </button>
              </div>

              {/* Search & Filter Bar */}
              <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-[240px]">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
                    <input
                      type="text"
                      placeholder="Search by license key or customer email..."
                      value={licenseSearchQuery}
                      onChange={(e) => setLicenseSearchQuery(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={licenseProductFilter}
                    onChange={(e) => setLicenseProductFilter(e.target.value)}
                    className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">All Products</option>
                    {productsList.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={licenseStatusFilter}
                    onChange={(e) => setLicenseStatusFilter(e.target.value)}
                    className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="all">All Statuses</option>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="revoked">Revoked</option>
                  </select>
                </div>
              </div>

              {licensesList.length === 0 ? (
                <div className="border border-dashed border-slate-800 rounded-2xl p-12 text-center">
                  <div className="w-12 h-12 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center mx-auto mb-3">
                    <Key className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-semibold text-white mb-1">No licenses found</h4>
                  <p className="text-xs text-slate-400 max-w-sm mx-auto mb-4">
                    {licenseSearchQuery || licenseProductFilter || licenseStatusFilter !== "all"
                      ? "No licenses match your filter criteria. Try resetting the filters."
                      : "Issue a license key manually to test client activations, or configure payment webhooks to issue licenses automatically."}
                  </p>
                  <button
                    onClick={() => setIsIssueLicenseOpen(true)}
                    disabled={productsList.length === 0 || policiesList.length === 0}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-medium text-white rounded-lg transition-colors"
                  >
                    Issue License
                  </button>
                </div>
              ) : (
                <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-950/60 border-b border-slate-800 uppercase tracking-wider text-[11px] text-slate-400">
                      <tr>
                        <th className="py-3 px-4">License Key</th>
                        <th className="py-3 px-4">Customer</th>
                        <th className="py-3 px-4">Product & Policy</th>
                        <th className="py-3 px-4">Seats Occupied</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4">Expires</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80">
                      {licensesList.map((lic) => (
                        <tr key={lic.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-3.5 px-4 font-mono font-medium text-indigo-300">
                            <div className="flex items-center gap-1.5">
                              <span>{lic.key}</span>
                              <button
                                onClick={() => handleCopyText(lic.key, lic.id)}
                                title="Copy License Key"
                                className="text-slate-500 hover:text-slate-300"
                              >
                                {copiedKey === lic.id ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </div>
                          </td>
                          <td className="py-3.5 px-4 text-slate-200">{lic.customerEmail}</td>
                          <td className="py-3.5 px-4">
                            <div className="text-slate-200 font-medium">{lic.productName}</div>
                            <div className="text-[11px] text-slate-400">{lic.policyName}</div>
                          </td>
                          <td className="py-3.5 px-4">
                            <span className="font-semibold text-white">{lic.machinesCount ?? 0}</span>
                            <span className="text-slate-500"> / {lic.maxMachines ?? 1}</span>
                          </td>
                          <td className="py-3.5 px-4">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                                lic.status === "active"
                                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                  : lic.status === "suspended"
                                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                  : "bg-red-500/20 text-red-300 border border-red-500/30"
                              }`}
                            >
                              {lic.status}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-slate-400">
                            {lic.expiresAt
                              ? new Date(lic.expiresAt).toLocaleDateString()
                              : "Perpetual"}
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => {
                                  setInspectingLicenseId(lic.id);
                                  setIsLicenseDetailOpen(true);
                                }}
                                className="px-2.5 py-1 rounded bg-indigo-600/15 hover:bg-indigo-600/25 text-indigo-300 text-[11px] transition-colors border border-indigo-500/30 flex items-center gap-1"
                              >
                                <Monitor className="w-3 h-3" />
                                <span>Seats</span>
                              </button>
                              {lic.status === "active" ? (
                                <button
                                  onClick={() => handleSuspendLicense(lic.id)}
                                  className="px-2.5 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-[11px] transition-colors border border-amber-500/30"
                                >
                                  Suspend
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleReinstateLicense(lic.id)}
                                  className="px-2.5 py-1 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-[11px] transition-colors border border-emerald-500/30"
                                >
                                  Reinstate
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 5. PAYMENT & WEBHOOKS TAB */}
          {activeNav === "gateways" && (
            <div className="max-w-4xl space-y-8">
              {/* Payment Gateway Webhook Binding */}
              <div className="bg-slate-800/50 border border-slate-700/70 rounded-xl p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-base font-semibold text-white">Inbound Payment Webhook Binding</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Configure your payment provider's webhook secret to automatically issue licenses upon checkout.
                    </p>
                  </div>
                  {/* Tab Switcher: Paddle (Default) vs Stripe vs Lemon Squeezy */}
                  <div className="bg-slate-900 border border-slate-700 rounded-lg p-1 flex items-center gap-1">
                    {(["paddle", "stripe", "lemonsqueezy"] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => {
                          setPaymentProvider(p);
                          setWebhookSecretInput("");
                          setPaymentSaveMessage(null);
                        }}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                          paymentProvider === p
                            ? "bg-indigo-600 text-white shadow-sm"
                            : "text-slate-400 hover:text-white"
                        }`}
                      >
                        {p === "lemonsqueezy" ? "Lemon Squeezy" : p === "paddle" ? "Paddle (Default)" : "Stripe"}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Webhook Endpoint Display */}
                <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-4 mb-6">
                  <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">
                    {paymentProvider === "paddle" ? "Paddle" : paymentProvider === "stripe" ? "Stripe" : "Lemon Squeezy"} Webhook URL (Paste into provider portal)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={webhookCallbackUrl}
                      className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-indigo-300 font-mono select-all focus:outline-none"
                    />
                    <button
                      onClick={() => copyToClipboard(webhookCallbackUrl)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-white rounded font-medium border border-slate-700 transition-colors"
                    >
                      {copiedUrl ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedUrl ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-2">
                    {paymentProvider === "paddle" && "Events to subscribe: transaction.completed, subscription.canceled, subscription.paused."}
                    {paymentProvider === "stripe" && "Events to subscribe: checkout.session.completed, customer.subscription.deleted, invoice.payment_failed."}
                    {paymentProvider === "lemonsqueezy" && "Events to subscribe: order_created, subscription_cancelled, subscription_resumed."}
                  </p>
                </div>

                {/* Gateway Webhook Secret Form */}
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-medium text-slate-300">
                        {paymentProvider === "paddle"
                          ? "Paddle Notification Secret Key"
                          : paymentProvider === "stripe"
                          ? "Stripe Webhook Signing Secret"
                          : "Lemon Squeezy Webhook Signing Secret"}
                      </label>
                      {settingsData?.account?.payment_configs?.[paymentProvider]?.webhook_secret_masked && (
                        <span className="text-[11px] text-emerald-400 font-mono bg-emerald-950/60 border border-emerald-800/50 px-2 py-0.5 rounded">
                          Configured: {settingsData.account.payment_configs[paymentProvider].webhook_secret_masked}
                        </span>
                      )}
                    </div>
                    <input
                      type="password"
                      value={webhookSecretInput}
                      onChange={(e) => setWebhookSecretInput(e.target.value)}
                      placeholder={
                        paymentProvider === "paddle"
                          ? "pdl_ntf_set_..."
                          : paymentProvider === "stripe"
                          ? "whsec_..."
                          : "your_webhook_secret"
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      Only the webhook signing secret is stored (AES-256-GCM encrypted). No high-privilege API keys or seller IDs are required.
                    </p>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    {paymentSaveMessage ? (
                      <span className="text-xs text-emerald-400 font-medium">{paymentSaveMessage}</span>
                    ) : <span />}
                    <button
                      onClick={handleSavePaymentConfig}
                      disabled={isSavingPayment || !webhookSecretInput.trim()}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-white rounded-lg transition-colors shadow"
                    >
                      {isSavingPayment ? "Saving..." : "Save Webhook Secret (AES-256-GCM Encrypted)"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Outbound Webhooks (Option A: Pure Webhook Architecture) */}
              <div className="bg-slate-800/50 border border-slate-700/70 rounded-xl p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-base font-semibold text-white">Outbound Webhooks (Broadcast to Resend / Zapier)</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      LicenKit is 100% decoupled from raw SMTP. License issuance and renewal events are asynchronously
                      broadcast via Cloudflare Queues to your webhook endpoints.
                    </p>
                  </div>
                  <button className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs font-medium text-white rounded-lg transition-colors">
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Endpoint</span>
                  </button>
                </div>
                <div className="text-center py-6 border border-dashed border-slate-700 rounded-lg text-slate-400 text-xs">
                  No custom outbound endpoints configured yet. Click "Add Endpoint" to stream events to your email provider or automation webhook.
                </div>
              </div>
            </div>
          )}

          {/* 6. SETTINGS TAB */}
          {activeNav === "settings" && (
            <div className="max-w-2xl bg-slate-800/50 border border-slate-700/70 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-semibold text-white mb-2">Instance & Domain Settings</h3>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Instance Name</label>
                <input
                  type="text"
                  defaultValue={settingsData?.system?.instance_name || "LicenKit Hub"}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">App URL</label>
                <input
                  type="url"
                  defaultValue={settingsData?.system?.app_url || window.location.origin}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">API Base URL</label>
                <input
                  type="url"
                  placeholder="Defaults to App URL/api/v1 (Zero CORS)"
                  defaultValue={settingsData?.system?.api_base_url || ""}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  When left blank, the API runs directly at <code>/api/v1/*</code> on the same domain as this dashboard.
                </p>
              </div>
            </div>
          )}

          {/* 7. TEAM TAB */}
          {activeNav === "team" && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <p className="text-sm text-slate-400">Collaborate with administrators and team members.</p>
                <button className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg">
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Member</span>
                </button>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/70 rounded-xl divide-y divide-slate-800">
                <div className="p-4 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-white">{user.name} (You)</div>
                    <div className="text-xs text-slate-400">{user.email}</div>
                  </div>
                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 uppercase font-semibold">
                    {user.role}
                  </span>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* MODALS */}
      <CreateProductModal
        isOpen={isCreateProductOpen}
        onClose={() => setIsCreateProductOpen(false)}
        onSuccess={loadDashboardData}
      />

      <CreatePolicyModal
        isOpen={isCreatePolicyOpen}
        onClose={() => setIsCreatePolicyOpen(false)}
        onSuccess={loadDashboardData}
        products={productsList}
      />

      <IssueLicenseModal
        isOpen={isIssueLicenseOpen}
        onClose={() => setIsIssueLicenseOpen(false)}
        onSuccess={loadDashboardData}
        products={productsList}
        policies={policiesList}
      />

      <EditProductModal
        isOpen={isEditProductOpen}
        onClose={() => {
          setIsEditProductOpen(false);
          setEditingProduct(null);
        }}
        onSuccess={loadDashboardData}
        product={editingProduct}
      />

      <EditPolicyModal
        isOpen={isEditPolicyOpen}
        onClose={() => {
          setIsEditPolicyOpen(false);
          setEditingPolicy(null);
        }}
        onSuccess={loadDashboardData}
        policy={editingPolicy}
      />

      <LicenseDetailModal
        isOpen={isLicenseDetailOpen}
        onClose={() => {
          setIsLicenseDetailOpen(false);
          setInspectingLicenseId(null);
        }}
        onSuccess={loadDashboardData}
        licenseId={inspectingLicenseId}
      />
    </div>
  );
};
