import { useEffect, useState, type FormEvent } from "react";
import { MailPlus, RefreshCw, RotateCw, UserMinus } from "lucide-react";
import { api, type InstanceInvitation, type InstanceMember, type MembershipStatus, type Role } from "../../lib/api-client";
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, PageHeader, Select, StatusBadge, formatDate } from "../../components/ui";

const roles: Role[] = ["owner", "admin", "member", "viewer"];

export function MembersView({ currentUserId, canManage }: { currentUserId: string; canManage: boolean }) {
  const [members, setMembers] = useState<InstanceMember[]>([]);
  const [invitations, setInvitations] = useState<InstanceInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", role: "member" as Role });

  async function load() {
    setLoading(true); setError(null);
    const results = await Promise.allSettled([api.admin.members.list(), api.admin.invitations.list()]);
    if (results[0].status === "fulfilled") setMembers(results[0].value.items);
    if (results[1].status === "fulfilled") setInvitations(results[1].value.items);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason);
    setLoading(false);
  }
  useEffect(() => { void load() }, []);

  async function updateMember(member: InstanceMember, body: { role?: Role; status?: MembershipStatus }) {
    setSavingId(member.userId); setError(null);
    try {
      const result = await api.admin.members.update(member.userId, body);
      setMembers((current) => current.map((item) => item.userId === result.userId ? result : item));
    } catch (caught) { setError(caught) } finally { setSavingId(null) }
  }

  async function invite(event: FormEvent) {
    event.preventDefault(); setSavingId("invite"); setError(null);
    try {
      await api.admin.invitations.create({ email: inviteForm.email.trim(), role: inviteForm.role });
      setInviteOpen(false); setInviteForm({ email: "", role: "member" }); await load();
    } catch (caught) { setError(caught) } finally { setSavingId(null) }
  }

  async function revokeInvitation(invitation: InstanceInvitation) {
    if (!window.confirm(`撤销发给 ${invitation.email} 的邀请？`)) return;
    setSavingId(invitation.id); setError(null);
    try { await api.admin.invitations.revoke(invitation.id); await load() } catch (caught) { setError(caught) } finally { setSavingId(null) }
  }

  async function resendInvitation(invitation: InstanceInvitation) {
    setSavingId(invitation.id); setError(null);
    try { await api.admin.invitations.resend(invitation.id); await load() } catch (caught) { setError(caught) } finally { setSavingId(null) }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Instance Membership" title="Members" description="角色和访问状态属于当前 Instance。邀请接受前不会创建占位 User 或 Membership。" action={<div className="button-row"><Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>{canManage ? <Button onClick={() => setInviteOpen(true)}><MailPlus className="size-4" />邀请成员</Button> : null}</div>} />
      <ErrorPanel error={error} />
      {loading && members.length + invitations.length === 0 ? <LoadingState /> : (
        <>
          <Card>
            <div className="card-header"><div><p className="eyebrow">Memberships</p><h2>当前成员</h2><p>Owner 可以调整当前 Instance 的角色、暂停、恢复或软移除 Membership；不能修改 User 的邮箱、显示名称或密码。</p></div><Badge>{members.length}</Badge></div>
            {members.length === 0 ? <EmptyState title="没有可见成员" description="首次 Setup 创建的 Owner Membership 应显示在这里。" /> : (
              <div className="table-wrap"><table><thead><tr><th>User</th><th>角色</th><th>状态</th><th>加入时间</th><th>操作</th></tr></thead><tbody>{members.map((member) => {
                const isCurrent = member.userId === currentUserId;
                return <tr key={member.userId}><td><strong>{member.user.name}{isCurrent ? "（你）" : ""}</strong><small>{member.user.email}</small></td><td>{canManage ? <Select aria-label={`${member.user.email} 的角色`} value={member.role} disabled={savingId === member.userId || member.status === "removed"} onChange={(event) => void updateMember(member, { role: event.target.value as Role })}>{roles.map((role) => <option key={role} value={role}>{role}</option>)}</Select> : <Badge>{member.role}</Badge>}</td><td><StatusBadge status={member.status} /></td><td>{formatDate(member.createdAt)}</td><td>{canManage && member.status !== "removed" ? <div className="button-row wrap">{member.status === "active" ? <Button variant="secondary" loading={savingId === member.userId} onClick={() => void updateMember(member, { status: "disabled" })}>暂停</Button> : <Button variant="secondary" loading={savingId === member.userId} onClick={() => void updateMember(member, { status: "active" })}>恢复</Button>}<Button variant="danger" loading={savingId === member.userId} onClick={() => { if (window.confirm(`从当前 Instance 软移除 ${member.user.email}？重新加入需要新邀请。`)) void updateMember(member, { status: "removed" }) }}><UserMinus className="size-4" />移除</Button></div> : member.status === "removed" ? <small>需重新邀请</small> : null}</td></tr>;
              })}</tbody></table></div>
            )}
          </Card>
          <Card>
            <div className="card-header"><div><p className="eyebrow">Invitations</p><h2>成员邀请</h2><p>重新发送会撤销旧 Token 并创建新邀请；旧链接随即失效。</p></div><Badge>{invitations.length}</Badge></div>
            {invitations.length === 0 ? <EmptyState title="暂无邀请" description="Owner 可以通过邮件邀请成员加入当前 Instance。" /> : <div className="table-wrap"><table><thead><tr><th>邮箱</th><th>角色</th><th>状态</th><th>投递</th><th>有效期</th><th>操作</th></tr></thead><tbody>{invitations.map((invitation) => <tr key={invitation.id}><td><strong>{invitation.email}</strong><small>{formatDate(invitation.createdAt)}</small></td><td><Badge>{invitation.role}</Badge></td><td><StatusBadge status={invitation.status} /></td><td><StatusBadge status={invitation.delivery?.status} /></td><td>{formatDate(invitation.expiresAt)}</td><td>{canManage && invitation.status === "pending" ? <div className="button-row wrap"><Button variant="secondary" loading={savingId === invitation.id} onClick={() => void resendInvitation(invitation)}><RotateCw className="size-4" />重新发送</Button><Button variant="danger" loading={savingId === invitation.id} onClick={() => void revokeInvitation(invitation)}>撤销</Button></div> : null}</td></tr>)}</tbody></table></div>}
          </Card>
        </>
      )}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="邀请成员" description="受邀者会自己证明身份或设置密码；邀请人不能代设密码。">
        <form className="form-stack" onSubmit={invite}>
          <Field label="邮箱"><Input type="email" value={inviteForm.email} onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })} autoComplete="email" required /></Field>
          <Field label="角色"><Select value={inviteForm.role} onChange={(event) => setInviteForm({ ...inviteForm, role: event.target.value as Role })}>{roles.map((role) => <option key={role} value={role}>{role}</option>)}</Select></Field>
          <div className="form-actions"><Button variant="secondary" type="button" onClick={() => setInviteOpen(false)}>取消</Button><Button type="submit" loading={savingId === "invite"}>发送邀请</Button></div>
        </form>
      </Modal>
    </div>
  );
}
