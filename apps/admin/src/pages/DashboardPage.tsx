import { useState, type ComponentType } from "react";
import { Activity, Boxes, Building2, ChevronLeft, ChevronRight, CircleDollarSign, ContactRound, KeyRound, LayoutDashboard, LogOut, Mail, Menu, ScrollText, ShieldCheck, UserRound, UsersRound, X } from "lucide-react";
import type { AdminSession } from "../lib/api-client";
import { Button, ErrorBoundary } from "../components/ui";
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

type Section = "overview" | "products" | "license-plans" | "licenses" | "customers" | "billing" | "email-hub" | "operations" | "instance" | "members" | "profile";
interface NavItem { id: Section; label: string; description: string; icon: ComponentType<{ className?: string }> }

const nav: Array<{ label: string; items: NavItem[] }> = [
  { label: "总览", items: [
    { id: "overview", label: "运行总览", description: "核心指标与运行健康度", icon: LayoutDashboard },
  ] },
  { label: "授权目录", items: [
    { id: "products", label: "产品与发布", description: "受控产品与版本发布记录", icon: Boxes },
    { id: "license-plans", label: "授权方案", description: "生命周期规则与签发模板", icon: ScrollText },
  ] },
  { label: "授权运营", items: [
    { id: "licenses", label: "授权管理", description: "授权签发、条款与设备激活", icon: KeyRound },
    { id: "customers", label: "客户管理", description: "购买者身份与名下授权", icon: UsersRound },
  ] },
  { label: "商业连接", items: [
    { id: "billing", label: "支付通道", description: "Paddle 支付连接与收款就绪", icon: CircleDollarSign },
  ] },
  { label: "服务与运维", items: [
    { id: "email-hub", label: "邮件中心", description: "发信队列、投递日志与模板", icon: Mail },
    { id: "operations", label: "系统运维", description: "异常排查与 Webhook 入站事件", icon: Activity },
  ] },
  { label: "系统设置", items: [
    { id: "instance", label: "空间信息", description: "当前实例标识与部署状态", icon: Building2 },
    { id: "members", label: "团队成员", description: "成员角色与协作邀请", icon: ContactRound },
    { id: "profile", label: "个人资料", description: "登录账号与安全设置", icon: UserRound },
  ] },
];

export function DashboardPage({ session, onSessionChange, onLogout }: { session: AdminSession; onSessionChange: (session: AdminSession) => void; onLogout: () => void }) {
  const [section, setSection] = useState<Section>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [issueRevision, setIssueRevision] = useState(0);
  const { user, instance, membership } = session;
  const current = nav.flatMap((group) => group.items).find((item) => item.id === section)!;
  const CurrentIcon = current.icon;
  const canWrite = membership.role === "owner" || membership.role === "admin";

  return (
    <div className={collapsed ? "admin-shell sidebar-collapsed" : "admin-shell"}>
      {sidebarOpen ? <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} /> : null}
      <aside className={sidebarOpen ? "admin-sidebar open" : "admin-sidebar"}>
        <header className="sidebar-brand">
          <span className="brand-mark small"><ShieldCheck className="size-5" /></span>
          <div className="sidebar-brand-copy"><strong>LicenKit</strong><span>管理控制台</span></div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"><X className="size-5" /></button>
        </header>
        <nav className="sidebar-nav" aria-label="主导航">
          {nav.map((group) => (
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
          <div className="instance-chip"><span>{instance.name.slice(0, 1).toUpperCase()}</span><div><strong>{instance.name}</strong><small>{instance.slug}</small></div></div>
          <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "展开导航" : "收起导航"}>{collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}</button>
        </footer>
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Menu className="size-5" /></button>
          <div className="topbar-context"><CurrentIcon className="size-4" /><span>{current.label}</span></div>
          <div className="topbar-user"><div><strong>{user.name}</strong><span>{membership.role} · {user.email}</span></div><Button variant="ghost" onClick={onLogout}><LogOut className="size-4" />退出</Button></div>
        </header>
        <div className="admin-content">
          <InstanceIssueAlert refreshKey={issueRevision} onOpenIssues={() => setSection("operations")} />
          <ErrorBoundary key={section} fallbackTitle={`${current.label} 加载失败`}>
            {section === "overview" ? <OverviewView /> : null}
            {section === "products" ? <ProductsView canWrite={canWrite} /> : null}
            {section === "license-plans" ? <LicensePlansView canWrite={canWrite} /> : null}
            {section === "licenses" ? <LicensesView canManage={canWrite} canSupport={membership.role !== "viewer"} /> : null}
            {section === "customers" ? <CustomersView canManage={canWrite} /> : null}
            {section === "billing" ? <BillingView canManage={canWrite} /> : null}
            {section === "email-hub" ? <EmailHubView canManage={canWrite} /> : null}
            {section === "operations" ? <OperationsView canManage={canWrite} onIssuesChanged={() => setIssueRevision((value) => value + 1)} /> : null}
            {section === "instance" ? <InstanceView initialInstance={instance} /> : null}
            {section === "members" ? <MembersView currentUserId={user.id} canManage={membership.role === "owner"} /> : null}
            {section === "profile" ? <ProfileView initialUser={user} onUserUpdated={(updatedUser) => onSessionChange({ ...session, user: updatedUser })} /> : null}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
