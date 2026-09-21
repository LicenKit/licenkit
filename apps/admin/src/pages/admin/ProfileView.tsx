import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, RefreshCw, UserRound } from "lucide-react";
import { api, type User } from "../../lib/api-client";
import { Button, Card, ErrorPanel, Field, Input, Notice, PageHeader } from "../../components/ui";

export function ProfileView({ initialUser, onUserUpdated }: { initialUser: User; onUserUpdated: (user: User) => void }) {
  const [user, setUser] = useState(initialUser);
  const [name, setName] = useState(initialUser.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<"profile" | "password" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null); setMessage(null);
    try {
      const result = await api.admin.profile.get();
      setUser(result); setName(result.name); onUserUpdated(result);
    } catch (caught) { setError(caught) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, []);

  async function saveProfile(event: FormEvent) {
    event.preventDefault(); setSaving("profile"); setError(null); setMessage(null);
    try {
      const result = await api.admin.profile.update(name.trim());
      setUser(result); setName(result.name); onUserUpdated(result); setMessage("显示名称已更新。");
    } catch (caught) { setError(caught) } finally { setSaving(null) }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault(); setSaving("password"); setError(null); setMessage(null);
    try {
      await api.admin.profile.changePassword({ currentPassword, newPassword });
      setCurrentPassword(""); setNewPassword(""); setMessage("密码已更新，其他管理员 Session 已撤销。");
    } catch (caught) { setError(caught) } finally { setSaving(null) }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="全局身份" title="Profile" description="这里只管理当前 User 自己的身份资料。Instance Owner 不能从成员页面修改其他 User 的资料或密码。" action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>} />
      <ErrorPanel error={error} />
      {message ? <Notice tone="success"><strong>{message}</strong></Notice> : null}
      <div className="two-column">
        <Card>
          <div className="card-header"><div><p className="eyebrow">Profile</p><h2>基本资料</h2><p>邮箱是当前全局登录身份，本版本只读。</p></div><UserRound className="size-5" /></div>
          <form className="form-stack" onSubmit={saveProfile}>
            <Field label="显示名称"><Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></Field>
            <Field label="邮箱" hint="当前自部署不提供邮箱修改流程。"><Input type="email" value={user.email} readOnly disabled /></Field>
            <div className="form-actions"><Button type="submit" loading={saving === "profile"}>保存显示名称</Button></div>
          </form>
        </Card>
        <Card>
          <div className="card-header"><div><p className="eyebrow">Credentials</p><h2>修改密码</h2><p>修改成功后，除当前请求 Session 外的其他管理员 Session 都会失效。</p></div><KeyRound className="size-5" /></div>
          <form className="form-stack" onSubmit={changePassword}>
            <Field label="当前密码"><Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></Field>
            <Field label="新密码"><Input type="password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required /></Field>
            <div className="form-actions"><Button type="submit" loading={saving === "password"}>更新密码</Button></div>
          </form>
        </Card>
      </div>
    </div>
  );
}
