import React, { useState, useEffect } from "react";
import { api, type EnvCheckResponse } from "../lib/api-client";
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
  Trash2,
  Send,
  Lock,
  RefreshCw,
  CheckCircle2,
  History,
} from "lucide-react";
import { CreateProductModal } from "../components/modals/CreateProductModal";
import { CreatePolicyModal } from "../components/modals/CreatePolicyModal";
import { IssueLicenseModal } from "../components/modals/IssueLicenseModal";
import { EditProductModal } from "../components/modals/EditProductModal";
import { EditPolicyModal } from "../components/modals/EditPolicyModal";
import { LicenseDetailModal } from "../components/modals/LicenseDetailModal";
import { CreateWebhookModal } from "../components/modals/CreateWebhookModal";
import { CreateUserModal } from "../components/modals/CreateUserModal";
import { EditUserModal } from "../components/modals/EditUserModal";
import { AuditDetailModal } from "../components/modals/AuditDetailModal";

interface DashboardPageProps {
  user: any;
  account: any;
  onLogout: () => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ user, account, onLogout }) => {
  const [activeNav, setActiveNav] = useState<"overview" | "products" | "policies" | "licenses" | "gateways" | "settings" | "team" | "audit">("overview");

  // RBAC Permission Flags
  const isOwner = user?.role === "owner";
  const isAdmin = user?.role === "admin";
  const isMember = user?.role === "member";
  const isViewer = user?.role === "viewer";

  const canCreateProduct = isOwner || isAdmin;
  const canEditProduct = !isViewer;
  const canCreatePolicy = isOwner || isAdmin;
  const canEditPolicy = !isViewer;
  const canManageLicenses = !isViewer;
  const canManageWebhooks = isOwner || isAdmin;
  const canManageSettings = isOwner || isAdmin;
  const canAddMember = isOwner || isAdmin;
  const canEditMember = isOwner;

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
  const [licenseSeatFilter, setLicenseSeatFilter] = useState("all");

  // Copy tracking for keys inside tables/cards
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Outbound Webhook state
  const [isCreateWebhookOpen, setIsCreateWebhookOpen] = useState(false);
  const [webhooksList, setWebhooksList] = useState<any[]>([]);
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null);
  const [testWebhookResult, setTestWebhookResult] = useState<{ id: string; success: boolean; message: string } | null>(null);

  // Environment & Health state
  const [envCheck, setEnvCheck] = useState<EnvCheckResponse | null>(null);
  const [loadingEnvCheck, setLoadingEnvCheck] = useState(false);

  // Team state
  const [teamUsers, setTeamUsers] = useState<any[]>([]);
  const [loadingTeam, setLoadingTeam] = useState(false);
  const [isCreateUserOpen, setIsCreateUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any | null>(null);
  const [isEditUserOpen, setIsEditUserOpen] = useState(false);

  // Audit Logs state
  const [auditLogsList, setAuditLogsList] = useState<any[]>([]);
  const [auditPagination, setAuditPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [auditFilterAction, setAuditFilterAction] = useState("all");
  const [auditFilterResourceType, setAuditFilterResourceType] = useState("all");
  const [auditSearchQuery, setAuditSearchQuery] = useState("");
  const [inspectingAuditLog, setInspectingAuditLog] = useState<any | null>(null);
  const [isAuditDetailOpen, setIsAuditDetailOpen] = useState(false);

  const loadAuditLogs = async (page = 1) => {
    setLoadingAudit(true);
    try {
      const res = await api.audit.list({
        page,
        limit: 20,
        action: auditFilterAction !== "all" ? auditFilterAction : undefined,
        resourceType: auditFilterResourceType !== "all" ? auditFilterResourceType : undefined,
        query: auditSearchQuery.trim() || undefined,
      });
      setAuditLogsList(res.items || []);
      setAuditPagination(res.pagination || { page: 1, limit: 20, total: 0, totalPages: 1 });
    } catch (err) {
      console.error("Failed to load audit logs", err);
    } finally {
      setLoadingAudit(false);
    }
  };

  useEffect(() => {
    loadSettings();
    loadDashboardData();
    loadWebhooks();
    loadEnvCheck();
    loadTeamUsers();
  }, []);

  useEffect(() => {
    if (activeNav === "audit") {
      loadAuditLogs(1);
    }
  }, [activeNav, auditFilterAction, auditFilterResourceType]);


  const loadTeamUsers = async () => {
    setLoadingTeam(true);
    try {
      const res = await api.users.list();
      setTeamUsers(res.items || []);
    } catch (err) {
      console.error("Failed to load team members", err);
    } finally {
      setLoadingTeam(false);
    }
  };

  const handleDeleteUser = async (targetUser: any) => {
    if (!confirm(`Are you sure you want to remove ${targetUser.name} (${targetUser.email}) from the team?`)) {
      return;
    }
    try {
      await api.users.delete(targetUser.id);
      loadTeamUsers();
    } catch (err: any) {
      alert(err.message || "Failed to remove user");
    }
  };

  const loadEnvCheck = async () => {
    setLoadingEnvCheck(true);
    try {
      const res = await api.settings.getEnvCheck();
      setEnvCheck(res);
    } catch (err) {
      console.error("Failed to load environment diagnostic checklist", err);
    } finally {
      setLoadingEnvCheck(false);
    }
  };

  const loadWebhooks = async () => {
    try {
      const res = await api.webhooks.listEndpoints();
      setWebhooksList(res.items || []);
    } catch (e) {
      console.error("Failed to load webhooks", e);
    }
  };

  const handleTestWebhook = async (endpointId: string) => {
    setTestingWebhookId(endpointId);
    setTestWebhookResult(null);
    try {
      const res = await api.webhooks.testEndpoint(endpointId);
      if (res?.delivered) {
        setTestWebhookResult({
          id: endpointId,
          success: true,
          message: `HTTP ${res.status} (${res.durationMs}ms) - Test ping delivered successfully!`,
        });
      } else {
        setTestWebhookResult({
          id: endpointId,
          success: false,
          message: `HTTP ${res?.status || "Error"} (${res?.durationMs || 0}ms) - ${res?.statusText || "Delivery failed"}`,
        });
      }
    } catch (err: any) {
      setTestWebhookResult({
        id: endpointId,
        success: false,
        message: err.message || "Failed to reach endpoint",
      });
    } finally {
      setTestingWebhookId(null);
    }
  };

  const handleDeleteWebhook = async (endpointId: string) => {
    if (!window.confirm("Are you sure you want to delete this outbound webhook endpoint?")) return;
    try {
      await api.webhooks.deleteEndpoint(endpointId);
      loadWebhooks();
    } catch (err: any) {
      alert(err.message || "Failed to delete webhook endpoint");
    }
  };

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
          seatStatus: licenseSeatFilter !== "all" ? licenseSeatFilter : undefined,
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
        seatStatus: licenseSeatFilter !== "all" ? licenseSeatFilter : undefined,
      }).catch(() => ({ items: [] }));
      setLicensesList(lics.items || []);
    } catch (e) {
      console.error("Failed to load filtered licenses", e);
    }
  };

  useEffect(() => {
    loadFilteredLicenses();
  }, [licenseSearchQuery, licenseProductFilter, licenseStatusFilter, licenseSeatFilter]);

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

            <button
              onClick={() => setActiveNav("audit")}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeNav === "audit" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <History className="w-4 h-4" />
              <span>Audit Logs</span>
            </button>
          </nav>
        </div>

        {/* User Info & Logout */}
        <div className="pt-4 border-t border-slate-800/80">
          <div className="flex items-center justify-between px-2 py-1">
            <div className="overflow-hidden pr-2">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-white truncate">{user.name}</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded uppercase font-semibold tracking-wider bg-slate-800 text-indigo-300 border border-slate-700 shrink-0">
                  {user.role}
                </span>
              </div>
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
            {activeNav === "gateways" ? "Payment Gateways & Webhooks" : activeNav === "audit" ? "Audit Logs & Activity Stream" : activeNav}
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
                  {canCreateProduct && (
                    <button
                      onClick={() => setIsCreateProductOpen(true)}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors shadow cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Create Product</span>
                    </button>
                  )}
                  {canManageLicenses && (
                    <button
                      onClick={() => setIsIssueLicenseOpen(true)}
                      disabled={productsList.length === 0 || policiesList.length === 0}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-medium text-white rounded-lg transition-colors border border-slate-700 cursor-pointer"
                    >
                      <Key className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Issue License</span>
                    </button>
                  )}
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
                {canCreateProduct && (
                  <button
                    onClick={() => setIsCreateProductOpen(true)}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors shadow cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create Product</span>
                  </button>
                )}
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
                  {canCreateProduct && (
                    <button
                      onClick={() => setIsCreateProductOpen(true)}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors cursor-pointer"
                    >
                      Create Product
                    </button>
                  )}
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
                            {canEditProduct && (
                              <button
                                onClick={() => {
                                  setEditingProduct(p);
                                  setIsEditProductOpen(true);
                                }}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60 transition-colors cursor-pointer"
                                title="Edit Product"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                            )}
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
                {canCreatePolicy && (
                  <button
                    onClick={() => setIsCreatePolicyOpen(true)}
                    disabled={productsList.length === 0}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-medium text-white rounded-lg transition-colors shadow cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create Policy</span>
                  </button>
                )}
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
                  {canCreatePolicy && (
                    <button
                      onClick={() => (productsList.length === 0 ? setIsCreateProductOpen(true) : setIsCreatePolicyOpen(true))}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors cursor-pointer"
                    >
                      {productsList.length === 0 ? "Create Product First" : "Create Policy"}
                    </button>
                  )}
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
                            {canEditPolicy && (
                              <button
                                onClick={() => {
                                  setEditingPolicy(pol);
                                  setIsEditPolicyOpen(true);
                                }}
                                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] transition-colors border border-slate-700 inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Edit3 className="w-3 h-3" />
                                <span>Edit</span>
                              </button>
                            )}
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
                <div className="flex items-center gap-2">
                  {canManageLicenses && (
                    <button
                      onClick={() => setIsIssueLicenseOpen(true)}
                      disabled={productsList.length === 0 || policiesList.length === 0}
                      className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-medium text-white rounded-lg transition-colors shadow cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Issue License</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Search & Filter Bar */}
              <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-[240px]">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
                    <input
                      type="text"
                      placeholder="Search by License ID, Key or customer email..."
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
                  <select
                    value={licenseSeatFilter}
                    onChange={(e) => setLicenseSeatFilter(e.target.value)}
                    className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="all">All Seats</option>
                    <option value="unused">Unused (0 Seats)</option>
                    <option value="in_use">In Use (≥1 Seat)</option>
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
                    {licenseSearchQuery || licenseProductFilter || licenseStatusFilter !== "all" || licenseSeatFilter !== "all"
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
                        <th className="py-3 px-4">License ID</th>
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
                              <span title={lic.id}>{lic.id.slice(0, 12)}...</span>
                              <button
                                onClick={() => handleCopyText(lic.id, lic.id)}
                                title="Copy License ID"
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
                          <td className="py-3.5 px-4 text-slate-200">
                            {lic.customerEmail ? (
                              <span>{lic.customerEmail}</span>
                            ) : (
                              <span className="text-slate-500 italic">Unassigned</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="text-slate-200 font-medium">{lic.productName}</div>
                            <div className="text-[11px] text-slate-400">{lic.policyName}</div>
                          </td>
                          <td className="py-3.5 px-4">
                            <span className="font-semibold text-white">{lic.machinesCount ?? 0}</span>
                            <span className="text-slate-500"> / {lic.maxMachines ?? 1}</span>
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="flex flex-col gap-1">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase w-fit ${
                                  lic.status === "active"
                                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                    : lic.status === "suspended"
                                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                    : "bg-red-500/20 text-red-300 border border-red-500/30"
                                }`}
                              >
                                {lic.status}
                              </span>
                              {lic.status === "revoked" && lic.revokeReason && (
                                <span className="text-[10px] text-red-400 font-mono truncate max-w-[130px]" title={lic.revokeReason}>
                                  {lic.revokeReason === "EXPIRED_30_DAYS_UNUSED" ? "30d Unused" : lic.revokeReason}
                                </span>
                              )}
                            </div>
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
                              {canManageLicenses && (
                                lic.status === "active" ? (
                                  <button
                                    onClick={() => handleSuspendLicense(lic.id)}
                                    className="px-2.5 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-[11px] transition-colors border border-amber-500/30 cursor-pointer"
                                  >
                                    Suspend
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => handleReinstateLicense(lic.id)}
                                    className="px-2.5 py-1 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-[11px] transition-colors border border-emerald-500/30 cursor-pointer"
                                  >
                                    Reinstate
                                  </button>
                                )
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
                  {/* Tab Switcher: Paddle vs Stripe vs Lemon Squeezy */}
                  <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
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
                        {p === "lemonsqueezy" ? "Lemon Squeezy" : p === "paddle" ? "Paddle" : "Stripe"}
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
                    {canManageSettings && (
                      <button
                        onClick={handleSavePaymentConfig}
                        disabled={isSavingPayment || !webhookSecretInput.trim()}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-white rounded-lg transition-colors shadow cursor-pointer"
                      >
                        {isSavingPayment ? "Saving..." : "Save Webhook Secret (AES-256-GCM Encrypted)"}
                      </button>
                    )}
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
                  {canManageWebhooks && (
                    <button
                      onClick={() => setIsCreateWebhookOpen(true)}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg transition-colors shadow cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Endpoint</span>
                    </button>
                  )}
                </div>

                {webhooksList.length === 0 ? (
                  <div className="text-center py-8 border border-dashed border-slate-700 rounded-lg text-slate-400 text-xs">
                    No custom outbound endpoints configured yet. Click "Add Endpoint" to stream events to your email provider or automation webhook.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-700/60 border border-slate-700/80 rounded-lg overflow-hidden bg-slate-900/50">
                    {webhooksList.map((wh) => (
                      <div key={wh.id} className="p-4 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono font-medium text-indigo-400 bg-indigo-950/60 border border-indigo-800/50 px-2 py-0.5 rounded">
                              {wh.productName}
                            </span>
                            <span className="text-sm font-mono text-white font-medium break-all">
                              {wh.url}
                            </span>
                          </div>
                          {canManageWebhooks && (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleTestWebhook(wh.id)}
                                disabled={testingWebhookId === wh.id}
                                className="flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-medium rounded-md transition-colors border border-slate-700 cursor-pointer"
                              >
                                <Send className="w-3 h-3" />
                                <span>{testingWebhookId === wh.id ? "Testing..." : "Send Test"}</span>
                              </button>
                              <button
                                onClick={() => handleDeleteWebhook(wh.id)}
                                className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors cursor-pointer"
                                title="Delete Endpoint"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="text-slate-500 text-[11px]">Events:</span>
                          {(wh.events || ["*"]).map((e: string) => (
                            <span
                              key={e}
                              className="px-1.5 py-0.5 bg-slate-800 text-slate-300 rounded text-[11px] font-mono border border-slate-700"
                            >
                              {e}
                            </span>
                          ))}
                          <span className="text-slate-600 text-[11px] ml-auto font-mono">
                            Secret: {wh.secretMasked}
                          </span>
                        </div>

                        {testWebhookResult && testWebhookResult.id === wh.id && (
                          <div
                            className={`p-2.5 rounded-lg text-xs flex items-center justify-between ${
                              testWebhookResult.success
                                ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-300"
                                : "bg-rose-500/10 border border-rose-500/30 text-rose-300"
                            }`}
                          >
                            <span>{testWebhookResult.message}</span>
                            <button
                              onClick={() => setTestWebhookResult(null)}
                              className="text-slate-400 hover:text-slate-200 ml-2"
                            >
                              ✕
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 6. SETTINGS TAB */}
          {activeNav === "settings" && (
            <div className="max-w-2xl space-y-6">
              {/* Card 1: Environment & Infrastructure Health Checklist */}
              <div className="bg-slate-800/50 border border-slate-700/70 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-700/60 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded-lg text-indigo-400">
                      <Lock className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white">Environment & Secrets Checklist</h3>
                      <p className="text-xs text-slate-400">
                        Zero In-Code Secrets baseline. Live diagnosis of Cloudflare Bindings & Master Keys.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-indigo-300 capitalize">
                      {envCheck?.environment || "development"}
                    </span>
                    <button
                      onClick={loadEnvCheck}
                      disabled={loadingEnvCheck}
                      className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition-colors border border-slate-700"
                      title="Refresh Environment Diagnosis"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loadingEnvCheck ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                </div>

                {loadingEnvCheck ? (
                  <div className="text-xs text-slate-400 py-3">Refreshing credentials checklist...</div>
                ) : (
                  <div className="space-y-2">
                    {envCheck?.items.map((item) => (
                      <div
                        key={item.key}
                        className="flex items-start justify-between p-3 rounded-lg bg-slate-900/60 border border-slate-700/50"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono font-semibold text-white">{item.key}</span>
                            <span className="text-[10px] text-slate-400 font-normal">({item.label})</span>
                            {item.required && (
                              <span className="text-[9px] uppercase px-1 py-0.2 rounded bg-indigo-950 text-indigo-400 border border-indigo-800">
                                Required
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400">{item.description}</p>
                          {item.status !== "ready" && (
                            <p className="text-[11px] font-mono text-amber-300 bg-amber-950/40 border border-amber-800/40 px-2 py-0.5 rounded mt-1 select-all">
                              {item.fixHint}
                            </p>
                          )}
                        </div>
                        <div className="shrink-0 ml-3">
                          {item.status === "ready" ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 bg-emerald-950/60 border border-emerald-800/50 px-2 py-0.5 rounded">
                              <CheckCircle2 className="w-3 h-3" />
                              <span>Configured</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-400 bg-rose-950/60 border border-rose-800/50 px-2 py-0.5 rounded">
                              <AlertTriangle className="w-3 h-3" />
                              <span className="uppercase">{item.status}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Card 2: Instance & Domain Settings */}
              <div className="bg-slate-800/50 border border-slate-700/70 rounded-xl p-6 space-y-4">
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
            </div>
          )}

          {/* 7. TEAM TAB */}
          {activeNav === "team" && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="text-sm font-medium text-white">Team Members</h3>
                  <p className="text-xs text-slate-400">Collaborate with administrators and team members.</p>
                </div>
                {canAddMember && (
                  <button
                    onClick={() => setIsCreateUserOpen(true)}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-xl transition-all cursor-pointer shadow-md shadow-indigo-600/20"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Member</span>
                  </button>
                )}
              </div>

              {loadingTeam ? (
                <div className="p-8 text-center text-slate-500 text-sm flex items-center justify-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Loading team members...</span>
                </div>
              ) : teamUsers.length === 0 ? (
                <div className="p-8 text-center bg-slate-800/30 border border-slate-700/60 rounded-xl text-slate-400 text-sm">
                  No members found.
                </div>
              ) : (
                <div className="bg-slate-800/50 border border-slate-700/70 rounded-xl divide-y divide-slate-800 overflow-hidden">
                  {teamUsers.map((u) => {
                    const isCurrentUser = u.id === user.id;
                    return (
                      <div
                        key={u.id}
                        className="p-4 flex items-center justify-between hover:bg-slate-800/40 transition-colors"
                      >
                        <div className="flex items-center gap-3.5">
                          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-300">
                            {u.name?.slice(0, 2).toUpperCase() || "U"}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-white">{u.name}</span>
                              {isCurrentUser && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-indigo-500/20 text-indigo-300 font-medium">
                                  You
                                </span>
                              )}
                              {u.isActive === false && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/20 text-amber-400 font-medium">
                                  Suspended
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-400">{u.email}</div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3">
                          <span
                            className={`text-xs px-2.5 py-0.5 rounded-full uppercase font-semibold tracking-wider ${
                              u.role === "owner"
                                ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                                : u.role === "admin"
                                ? "bg-indigo-500/20 text-indigo-400 border border-indigo-500/30"
                                : u.role === "member"
                                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                                : "bg-sky-500/20 text-sky-400 border border-sky-500/30"
                            }`}
                          >
                            {u.role}
                          </span>

                          {/* Action buttons: Only owner can edit roles or delete others */}
                          {canEditMember && (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => {
                                  setEditingUser(u);
                                  setIsEditUserOpen(true);
                                }}
                                title="Edit Role & Permissions"
                                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/60 rounded-lg transition-colors cursor-pointer"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>

                              {!isCurrentUser && u.role !== "owner" && (
                                <button
                                  onClick={() => handleDeleteUser(u)}
                                  title="Remove Member"
                                  className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors cursor-pointer"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* 8. AUDIT LOGS TAB */}
          {activeNav === "audit" && (
            <div className="space-y-6">
              {/* Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h3 className="text-xl font-bold text-white flex items-center gap-2">
                    <History className="w-5 h-5 text-indigo-400" />
                    Audit Logs & Operations Stream
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Immutable chronological record of administrative changes across this instance.
                  </p>
                </div>
                <button
                  onClick={() => loadAuditLogs(auditPagination.page)}
                  disabled={loadingAudit}
                  className="inline-flex items-center gap-2 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl border border-slate-700 transition-colors cursor-pointer self-start sm:self-auto"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingAudit ? "animate-spin" : ""}`} />
                  Refresh
                </button>
              </div>

              {/* Filters Bar */}
              <div className="bg-slate-900 border border-slate-800/80 p-4 rounded-xl flex flex-col sm:flex-row gap-3 items-center justify-between">
                {/* Search */}
                <div className="relative w-full sm:w-80">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Filter by operator, resource or action..."
                    value={auditSearchQuery}
                    onChange={(e) => setAuditSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && loadAuditLogs(1)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>

                {/* Dropdowns */}
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <select
                    value={auditFilterResourceType}
                    onChange={(e) => setAuditFilterResourceType(e.target.value)}
                    className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                  >
                    <option value="all">All Resources</option>
                    <option value="license">Licenses</option>
                    <option value="product">Products</option>
                    <option value="policy">Policies</option>
                    <option value="user">Team Users</option>
                    <option value="settings">Settings</option>
                    <option value="webhook">Webhooks</option>
                    <option value="auth">Authentication</option>
                  </select>

                  <select
                    value={auditFilterAction}
                    onChange={(e) => setAuditFilterAction(e.target.value)}
                    className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                  >
                    <option value="all">All Actions</option>
                    <option value="license.create">license.create</option>
                    <option value="license.update">license.update</option>
                    <option value="license.revoke">license.revoke</option>
                    <option value="license.suspend">license.suspend</option>
                    <option value="license.reinstate">license.reinstate</option>
                    <option value="license.rotate_key">license.rotate_key</option>
                    <option value="license.machine_unbind">license.machine_unbind</option>
                    <option value="product.create">product.create</option>
                    <option value="product.update">product.update</option>
                    <option value="product.delete">product.delete</option>
                    <option value="policy.create">policy.create</option>
                    <option value="policy.update">policy.update</option>
                    <option value="policy.delete">policy.delete</option>
                    <option value="user.create">user.create</option>
                    <option value="user.update">user.update</option>
                    <option value="user.delete">user.delete</option>
                    <option value="settings.update">settings.update</option>
                    <option value="webhook.create">webhook.create</option>
                    <option value="webhook.delete">webhook.delete</option>
                    <option value="webhook.test">webhook.test</option>
                    <option value="auth.login">auth.login</option>
                  </select>
                </div>
              </div>

              {/* Logs Table */}
              <div className="bg-slate-900 border border-slate-800/80 rounded-xl overflow-hidden">
                {loadingAudit ? (
                  <div className="p-12 text-center text-slate-400 text-sm flex items-center justify-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                    Loading audit stream...
                  </div>
                ) : auditLogsList.length === 0 ? (
                  <div className="p-12 text-center text-slate-400 text-sm">
                    No audit records match the selected criteria.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-slate-800 bg-slate-950/40 text-slate-400 font-medium uppercase tracking-wider text-[11px]">
                          <th className="py-3 px-4">Timestamp</th>
                          <th className="py-3 px-4">Operator</th>
                          <th className="py-3 px-4">Action</th>
                          <th className="py-3 px-4">Resource</th>
                          <th className="py-3 px-4">Client IP</th>
                          <th className="py-3 px-4 text-right">Details</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {auditLogsList.map((log) => {
                          const isDelete = log.action.includes("delete") || log.action.includes("revoke");
                          const isCreate = log.action.includes("create") || log.action.includes("reinstate");
                          const isUpdate = log.action.includes("update") || log.action.includes("rotate");
                          const isSuspend = log.action.includes("suspend");

                          const badgeClass = isDelete
                            ? "bg-rose-500/10 text-rose-400 border-rose-500/30"
                            : isCreate
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                            : isUpdate
                            ? "bg-sky-500/10 text-sky-400 border-sky-500/30"
                            : isSuspend
                            ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                            : "bg-purple-500/10 text-purple-400 border-purple-500/30";

                          return (
                            <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                              <td className="py-3 px-4 font-mono text-slate-400 whitespace-nowrap">
                                {new Date(log.createdAt).toLocaleString()}
                              </td>
                              <td className="py-3 px-4 whitespace-nowrap">
                                <span className="font-medium text-slate-200">{log.userEmail}</span>
                              </td>
                              <td className="py-3 px-4 whitespace-nowrap">
                                <span
                                  className={`inline-block px-2 py-0.5 rounded text-[10px] font-mono font-medium border ${badgeClass}`}
                                >
                                  {log.action}
                                </span>
                              </td>
                              <td className="py-3 px-4 whitespace-nowrap">
                                <div className="flex items-center gap-1.5 font-mono">
                                  <span className="text-[10px] uppercase font-bold text-slate-500">
                                    {log.resourceType}
                                  </span>
                                  {log.resourceId && (
                                    <span className="text-indigo-300 truncate max-w-[140px]" title={log.resourceId}>
                                      {log.resourceId}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-3 px-4 font-mono text-slate-400 whitespace-nowrap">
                                {log.ip || "127.0.0.1"}
                              </td>
                              <td className="py-3 px-4 text-right whitespace-nowrap">
                                <button
                                  onClick={() => {
                                    setInspectingAuditLog(log);
                                    setIsAuditDetailOpen(true);
                                  }}
                                  className="px-2.5 py-1 text-xs font-medium text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/10 rounded-lg transition-colors cursor-pointer"
                                >
                                  View Details
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Pagination */}
                {auditPagination.total > 0 && (
                  <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-950/20 text-xs text-slate-400">
                    <div>
                      Showing {(auditPagination.page - 1) * auditPagination.limit + 1} to{" "}
                      {Math.min(auditPagination.page * auditPagination.limit, auditPagination.total)} of{" "}
                      {auditPagination.total} entries
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => loadAuditLogs(auditPagination.page - 1)}
                        disabled={auditPagination.page <= 1}
                        className="px-3 py-1 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                      >
                        Previous
                      </button>
                      <span>
                        Page {auditPagination.page} of {auditPagination.totalPages || 1}
                      </span>
                      <button
                        onClick={() => loadAuditLogs(auditPagination.page + 1)}
                        disabled={auditPagination.page >= auditPagination.totalPages}
                        className="px-3 py-1 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
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
        readOnly={!canManageLicenses}
      />

      <CreateWebhookModal
        isOpen={isCreateWebhookOpen}
        onClose={() => setIsCreateWebhookOpen(false)}
        onSuccess={loadWebhooks}
        products={productsList}
      />

      <CreateUserModal
        isOpen={isCreateUserOpen}
        onClose={() => setIsCreateUserOpen(false)}
        onSuccess={loadTeamUsers}
      />

      <EditUserModal
        isOpen={isEditUserOpen}
        onClose={() => {
          setIsEditUserOpen(false);
          setEditingUser(null);
        }}
        onSuccess={loadTeamUsers}
        userToEdit={editingUser}
        currentUserId={user.id}
      />

      <AuditDetailModal
        isOpen={isAuditDetailOpen}
        onClose={() => {
          setIsAuditDetailOpen(false);
          setInspectingAuditLog(null);
        }}
        auditLog={inspectingAuditLog}
      />
    </div>
  );
};
