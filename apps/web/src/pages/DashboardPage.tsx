import { useState, type ComponentType } from "react";
import { Activity, Boxes, Building2, ChevronLeft, ChevronRight, CircleDollarSign, KeyRound, LayoutDashboard, LogOut, Menu, ScrollText, ShieldCheck, UsersRound, X } from "lucide-react";
import type { Account, AdminUser } from "../lib/api-client";
import { Button } from "../components/ui";
import { OverviewView } from "./admin/OverviewView";
import { ProductsView } from "./admin/ProductsView";
import { LicensePlansView } from "./admin/LicensePlansView";
import { LicensesView } from "./admin/LicensesView";
import { CustomersView } from "./admin/CustomersView";
import { BillingView } from "./admin/BillingView";
import { OperationsView } from "./admin/OperationsView";
import { AccountView } from "./admin/AccountView";

type Section = "overview" | "products" | "license-plans" | "licenses" | "customers" | "billing" | "operations" | "account";
interface NavItem { id: Section; label: string; description: string; icon: ComponentType<{ className?: string }> }

const nav: Array<{ label: string; items: NavItem[] }> = [
  { label: "总览", items: [{ id: "overview", label: "运行总览", description: "核心事实与待处理项", icon: LayoutDashboard }] },
  { label: "授权目录", items: [
    { id: "products", label: "产品与发布", description: "Product、Release 与试用", icon: Boxes },
    { id: "license-plans", label: "授权方案", description: "未来签发模板与 revision", icon: ScrollText },
  ] },
  { label: "授权运营", items: [
    { id: "licenses", label: "License", description: "条款、激活与敏感操作", icon: KeyRound },
    { id: "customers", label: "客户", description: "联系身份与客户会话", icon: UsersRound },
  ] },
  { label: "商业闭环", items: [
    { id: "billing", label: "支付与 Offer", description: "Paddle 连接与收款就绪", icon: CircleDollarSign },
    { id: "operations", label: "事件与投递", description: "Inbound Event、Delivery 诊断", icon: Activity },
  ] },
  { label: "管理", items: [{ id: "account", label: "账户与团队", description: "Account 默认值与权限", icon: Building2 }] },
];

export function DashboardPage({ user, account, onLogout }: { user: AdminUser; account: Account; onLogout: () => void }) {
  const [section, setSection] = useState<Section>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const visibleNav = user.role === "owner" ? nav : nav.map((group) => ({ ...group, items: group.items.filter((item) => item.id !== "account") })).filter((group) => group.items.length > 0);
  const current = visibleNav.flatMap((group) => group.items).find((item) => item.id === section)!;
  const CurrentIcon = current.icon;

  return (
    <div className={collapsed ? "admin-shell sidebar-collapsed" : "admin-shell"}>
      {sidebarOpen ? <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} /> : null}
      <aside className={sidebarOpen ? "admin-sidebar open" : "admin-sidebar"}>
        <header className="sidebar-brand">
          <span className="brand-mark small"><ShieldCheck className="size-5" /></span>
          <div className="sidebar-brand-copy"><strong>LicenKit</strong><span>V1 Control Plane</span></div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"><X className="size-5" /></button>
        </header>
        <nav className="sidebar-nav" aria-label="主导航">
          {visibleNav.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.id} className={section === item.id ? "nav-item active" : "nav-item"} title={collapsed ? item.label : undefined} onClick={() => { setSection(item.id); setSidebarOpen(false) }}>
                    <Icon className="size-5" />
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <footer className="sidebar-footer">
          <div className="account-chip"><span>{account.name.slice(0, 1).toUpperCase()}</span><div><strong>{account.name}</strong><small>{account.slug}</small></div></div>
          <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "展开导航" : "收起导航"}>{collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}</button>
        </footer>
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Menu className="size-5" /></button>
          <div className="topbar-context"><CurrentIcon className="size-4" /><span>{current.label}</span></div>
          <div className="topbar-user"><div><strong>{user.name}</strong><span>{user.role} · {user.email}</span></div><Button variant="ghost" onClick={onLogout}><LogOut className="size-4" />退出</Button></div>
        </header>
        <div className="admin-content">
          {section === "overview" ? <OverviewView /> : null}
          {section === "products" ? <ProductsView canWrite={user.role === "owner" || user.role === "admin"} /> : null}
          {section === "license-plans" ? <LicensePlansView canWrite={user.role === "owner" || user.role === "admin"} /> : null}
          {section === "licenses" ? <LicensesView canManage={user.role === "owner" || user.role === "admin"} canSupport={user.role !== "viewer"} /> : null}
          {section === "customers" ? <CustomersView canManage={user.role === "owner" || user.role === "admin"} /> : null}
          {section === "billing" ? <BillingView canManage={user.role === "owner" || user.role === "admin"} /> : null}
          {section === "operations" ? <OperationsView canManage={user.role === "owner" || user.role === "admin"} /> : null}
          {section === "account" ? <AccountView user={user} account={account} /> : null}
        </div>
      </div>
    </div>
  );
}
