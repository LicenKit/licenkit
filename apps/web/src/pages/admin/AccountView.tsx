import { useEffect, useState, type FormEvent } from "react";
import { Plus, RefreshCw, ShieldCheck, UserCog } from "lucide-react";
import { api, type Account, type AdminUser, type Role } from "../../lib/api-client";
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, Notice, PageHeader, Select, StatusBadge, formatDate } from "../../components/ui";

export function AccountView({ user, account: initialAccount }: { user: AdminUser; account: Account }) {
  const [account, setAccount] = useState(initialAccount);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [userModal, setUserModal] = useState(false);
  const [accountForm, setAccountForm] = useState({ name: initialAccount.name, grace: initialAccount.defaultSubscriptionPaymentGraceSeconds === undefined ? "" : String(initialAccount.defaultSubscriptionPaymentGraceSeconds) });
  const [userForm, setUserForm] = useState({ name: "", email: "", password: "", role: "member" as Exclude<Role, "owner"> });
  const isOwner = user.role === "owner";

  async function load() {
    setLoading(true); setError(null);
    try {
      const [accountResult, usersResult] = await Promise.all([api.admin.account.get(), api.admin.users.list()]);
      setAccount(accountResult); setUsers(usersResult.items);
      setAccountForm({ name: accountResult.name, grace: String(accountResult.defaultSubscriptionPaymentGraceSeconds) });
    } catch (caught) { setError(caught) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, []);

  async function saveAccount(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try { const result = await api.admin.account.update({ name: accountForm.name.trim(), defaultSubscriptionPaymentGraceSeconds: Number(accountForm.grace) }); setAccount(result) } catch (caught) { setError(caught) } finally { setSaving(false) }
  }
  async function createUser(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try { await api.admin.users.create({ ...userForm, name: userForm.name.trim(), email: userForm.email.trim() }); setUserModal(false); setUserForm({ name: "", email: "", password: "", role: "member" }); await load() } catch (caught) { setError(caught) } finally { setSaving(false) }
  }
  async function revokeSessions(target: AdminUser) {
    if (!window.confirm(`吊销 ${target.email} 的全部管理员 Session？`)) return;
    setSaving(true); setError(null);
    try { await api.admin.users.revokeSessions(target.id) } catch (caught) { setError(caught) } finally { setSaving(false) }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="租户安全边界" title="账户与团队" description="Account 是全部资源的授权上下文。角色权限由服务端 Session 决定，前端只隐藏无权操作。" action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>} />
      <ErrorPanel error={error} />
      {loading && users.length === 0 ? <LoadingState /> : <div className="two-column">
        <Card>
          <div className="card-header"><div><p className="eyebrow">Account</p><h2>{account.name}</h2><p className="mono">{account.id} · /{account.slug}</p></div><Badge tone="success">active</Badge></div>
          <form className="form-stack" onSubmit={saveAccount}><Field label="账户名称"><Input value={accountForm.name} onChange={(event) => setAccountForm({ ...accountForm, name: event.target.value })} disabled={!isOwner} /></Field><Field label="订阅支付宽限期默认值（秒）" hint="初始默认 432000（5 天）。只影响之后创建且未显式填写该字段的订阅授权方案。"><Input type="number" min="0" value={accountForm.grace} onChange={(event) => setAccountForm({ ...accountForm, grace: event.target.value })} disabled={!isOwner} /></Field>{isOwner ? <div className="form-actions"><Button type="submit" loading={saving}>保存 Account</Button></div> : null}</form>
          <Notice><ShieldCheck className="size-4" /><strong>不追溯修改</strong><p>修改 Account 默认值不会改变已有授权方案，也不会改变任何已签发 License Terms。</p></Notice>
        </Card>
        <Card>
          <div className="card-header"><div><p className="eyebrow">Default deny RBAC</p><h2>团队成员</h2><p>只有 owner 可以管理角色、账户与 Session。</p></div>{isOwner ? <Button onClick={() => setUserModal(true)}><Plus className="size-4" />添加成员</Button> : null}</div>
          {users.length === 0 ? <EmptyState title="没有可见成员" description="首位 Owner 只由一次性 Setup 创建。" /> : <div className="stack-list">{users.map((item) => <div className="stack-row" key={item.id}><span className="avatar">{item.name.slice(0, 1).toUpperCase()}</span><div className="grow"><strong>{item.name}</strong><span>{item.email} · 加入于 {formatDate(item.createdAt)}</span></div><Badge>{item.role}</Badge><StatusBadge status={item.status || "active"} />{isOwner && item.id !== user.id ? <Button variant="secondary" loading={saving} onClick={() => void revokeSessions(item)}><UserCog className="size-4" />吊销会话</Button> : null}</div>)}</div>}
        </Card>
      </div>}
      <Modal open={userModal} onClose={() => setUserModal(false)} title="添加管理员 User" description="Customer 不能登录管理控制台；这里创建的是管理员身份。">
        <form className="form-stack" onSubmit={createUser}><Field label="姓名"><Input value={userForm.name} onChange={(event) => setUserForm({ ...userForm, name: event.target.value })} required /></Field><Field label="邮箱"><Input type="email" value={userForm.email} onChange={(event) => setUserForm({ ...userForm, email: event.target.value })} required /></Field><Field label="初始密码"><Input type="password" minLength={12} value={userForm.password} onChange={(event) => setUserForm({ ...userForm, password: event.target.value })} autoComplete="new-password" required /></Field><Field label="角色"><Select value={userForm.role} onChange={(event) => setUserForm({ ...userForm, role: event.target.value as Exclude<Role, "owner"> })}><option value="admin">admin</option><option value="member">member</option><option value="viewer">viewer</option></Select></Field><div className="form-actions"><Button variant="secondary" type="button" onClick={() => setUserModal(false)}>取消</Button><Button type="submit" loading={saving}>创建成员</Button></div></form>
      </Modal>
    </div>
  );
}
