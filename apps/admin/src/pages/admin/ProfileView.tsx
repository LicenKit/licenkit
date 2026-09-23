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
      <PageHeader
        eyebrow="个人账号"
        title="个人资料"
        description="管理当前登录管理员的账户资料与安全凭据。"
        action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>}
      />
      <ErrorPanel error={error} />
      {message ? <Notice tone="success"><strong>{message}</strong></Notice> : null}
      <div className="two-column">
        <Card>
          <div className="card-header">
            <div>
              <p className="eyebrow">基本信息</p>
              <h2>个人信息</h2>
              <p>登录邮箱为管理员账户唯一标识，不可在此处直接修改。</p>
            </div>
            <UserRound className="size-5" />
          </div>
          <form className="form-stack" onSubmit={saveProfile}>
            <Field label="显示名称">
              <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
            </Field>
            <Field label="登录邮箱" hint="当前系统不支持在线更改管理员登录邮箱">
              <Input type="email" value={user.email} readOnly disabled />
            </Field>
            <div className="form-actions">
              <Button type="submit" loading={saving === "profile"}>保存个人信息</Button>
            </div>
          </form>
        </Card>
        <Card>
          <div className="card-header">
            <div>
              <p className="eyebrow">密码安全</p>
              <h2>修改登录密码</h2>
              <p>密码更新后，除当前浏览器外的其他登录会话将自动失效。</p>
            </div>
            <KeyRound className="size-5" />
          </div>
          <form className="form-stack" onSubmit={changePassword}>
            <Field label="当前密码">
              <Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required />
            </Field>
            <Field label="新密码" hint="长度不少于 12 位，建议组合使用大小写字母、数字及特殊符号">
              <Input type="password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required />
            </Field>
            <div className="form-actions">
              <Button type="submit" loading={saving === "password"}>确认修改密码</Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
