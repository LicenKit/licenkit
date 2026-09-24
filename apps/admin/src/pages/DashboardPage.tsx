import { useMemo, useState, type ComponentType } from "react";
import {
  Activity,
  Boxes,
  Building2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ContactRound,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  ScrollText,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import type { AdminSession } from "../lib/api-client";
import { Button, ErrorBoundary } from "../components/ui";
import { useI18n } from "../lib/i18n/I18nContext";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { OverviewView } from "./admin/OverviewView";
import { ProductsView } from "./admin/ProductsView";
import { LicensePlansView } from "./admin/LicensePlansView";
import { LicensesView } from "./admin/LicensesView";
import { CustomersView } from "./admin/CustomersView";
import { BillingView } from "./admin/BillingView";
import { OperationsView } from "./admin/OperationsView";
import { EmailHubView } from "./admin/EmailHubView";
import { InstanceView } from "./admin/InstanceView";
import { MembersView } from "./admin/MembersView";
import { ProfileView } from "./admin/ProfileView";
import { InstanceIssueAlert } from "./admin/InstanceIssueAlert";

type Section =
  | "overview"
  | "products"
  | "license-plans"
  | "licenses"
  | "customers"
  | "billing"
  | "email-hub"
  | "operations"
  | "instance"
  | "members"
  | "profile";

interface NavItem {
  id: Section;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export function DashboardPage({
  session,
  onSessionChange,
  onLogout,
}: {
  session: AdminSession;
  onSessionChange: (session: AdminSession) => void;
  onLogout: () => void;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [issueRevision, setIssueRevision] = useState(0);
  const { user, instance, membership } = session;

  const nav = useMemo<Array<{ label: string; items: NavItem[] }>>(
    () => [
      {
        label: t.nav.groupOverview,
        items: [
          { id: "overview", label: t.nav.itemOverview, description: t.nav.itemOverviewDesc, icon: LayoutDashboard },
        ],
      },
      {
        label: t.nav.groupCatalog,
        items: [
          { id: "products", label: t.nav.itemProducts, description: t.nav.itemProductsDesc, icon: Boxes },
          { id: "license-plans", label: t.nav.itemLicensePlans, description: t.nav.itemLicensePlansDesc, icon: ScrollText },
        ],
      },
      {
        label: t.nav.groupOperations,
        items: [
          { id: "licenses", label: t.nav.itemLicenses, description: t.nav.itemLicensesDesc, icon: KeyRound },
          { id: "customers", label: t.nav.itemCustomers, description: t.nav.itemCustomersDesc, icon: UsersRound },
        ],
      },
      {
        label: t.nav.groupCommercial,
        items: [
          { id: "billing", label: t.nav.itemBilling, description: t.nav.itemBillingDesc, icon: CircleDollarSign },
        ],
      },
      {
        label: t.nav.groupServices,
        items: [
          { id: "email-hub", label: t.nav.itemEmailHub, description: t.nav.itemEmailHubDesc, icon: Mail },
          { id: "operations", label: t.nav.itemOps, description: t.nav.itemOpsDesc, icon: Activity },
        ],
      },
      {
        label: t.nav.groupSettings,
        items: [
          { id: "instance", label: t.nav.itemInstance, description: t.nav.itemInstanceDesc, icon: Building2 },
          { id: "members", label: t.nav.itemMembers, description: t.nav.itemMembersDesc, icon: ContactRound },
          { id: "profile", label: t.nav.itemProfile, description: t.nav.itemProfileDesc, icon: UserRound },
        ],
      },
    ],
    [t]
  );

  const current = nav.flatMap((group) => group.items).find((item) => item.id === section)!;
  const CurrentIcon = current.icon;
  const canWrite = membership.role === "owner" || membership.role === "admin";

  return (
    <div className={collapsed ? "admin-shell sidebar-collapsed" : "admin-shell"}>
      {sidebarOpen ? (
        <button
          className="mobile-scrim"
          aria-label={t.nav.closeNav}
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <aside className={sidebarOpen ? "admin-sidebar open" : "admin-sidebar"}>
        <header className="sidebar-brand">
          <span className="brand-mark small">
            <ShieldCheck className="size-5" />
          </span>
          <div className="sidebar-brand-copy">
            <strong>LicenKit</strong>
            <span>{t.topbar.consoleTitle}</span>
          </div>
          <button
            className="icon-button mobile-only"
            onClick={() => setSidebarOpen(false)}
            aria-label={t.nav.closeNav}
          >
            <X className="size-5" />
          </button>
        </header>
        <nav className="sidebar-nav" aria-label={t.nav.mainNav}>
          {nav.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={section === item.id ? "nav-item active" : "nav-item"}
                    title={collapsed ? item.label : undefined}
                    onClick={() => {
                      setSection(item.id);
                      setSidebarOpen(false);
                    }}
                  >
                    <Icon className="size-5" />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <footer className="sidebar-footer">
          <div className="instance-chip">
            <span>{instance.name.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{instance.name}</strong>
              <small>{instance.slug}</small>
            </div>
          </div>
          <button
            className="collapse-button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? t.nav.expandNav : t.nav.collapseNav}
          >
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          </button>
        </footer>
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <button
            className="icon-button mobile-only"
            onClick={() => setSidebarOpen(true)}
            aria-label={t.nav.openNav}
          >
            <Menu className="size-5" />
          </button>
          <div className="topbar-context">
            <CurrentIcon className="size-4" />
            <span>{current.label}</span>
          </div>
          <div className="topbar-user">
            <LanguageSwitcher />
            <div>
              <strong>{user.name}</strong>
              <span>
                {t.topbar.roles[membership.role] || membership.role} · {user.email}
              </span>
            </div>
            <Button variant="ghost" onClick={onLogout}>
              <LogOut className="size-4" />
              {t.topbar.logout}
            </Button>
          </div>
        </header>
        <div className="admin-content">
          <InstanceIssueAlert
            refreshKey={issueRevision}
            onOpenIssues={() => setSection("operations")}
          />
          <ErrorBoundary key={section} fallbackTitle={t.topbar.viewLoadFailed(current.label)}>
            {section === "overview" ? <OverviewView /> : null}
            {section === "products" ? <ProductsView canWrite={canWrite} /> : null}
            {section === "license-plans" ? <LicensePlansView canWrite={canWrite} /> : null}
            {section === "licenses" ? (
              <LicensesView canManage={canWrite} canSupport={membership.role !== "viewer"} />
            ) : null}
            {section === "customers" ? <CustomersView canManage={canWrite} /> : null}
            {section === "billing" ? <BillingView canManage={canWrite} /> : null}
            {section === "email-hub" ? <EmailHubView canManage={canWrite} /> : null}
            {section === "operations" ? (
              <OperationsView
                canManage={canWrite}
                onIssuesChanged={() => setIssueRevision((value) => value + 1)}
              />
            ) : null}
            {section === "instance" ? <InstanceView initialInstance={instance} /> : null}
            {section === "members" ? (
              <MembersView currentUserId={user.id} canManage={membership.role === "owner"} />
            ) : null}
            {section === "profile" ? (
              <ProfileView
                initialUser={user}
                onUserUpdated={(updatedUser) =>
                  onSessionChange({ ...session, user: updatedUser })
                }
              />
            ) : null}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
