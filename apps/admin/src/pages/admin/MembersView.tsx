import { useEffect, useState, type FormEvent } from "react";
import { MailPlus, RefreshCw, RotateCw, UserMinus } from "lucide-react";
import { api, type InstanceInvitation, type InstanceMember, type MembershipStatus, type Role } from "../../lib/api-client";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, PageHeader, Select, StatusBadge, formatDate } from "../../components/ui";

const roles: { key: Role; label: string }[] = [
  { key: "owner", label: "所有者 (Owner)" },
  { key: "admin", label: "管理员 (Admin)" },
  { key: "member", label: "协作成员 (Member)" },
  { key: "viewer", label: "只读访客 (Viewer)" },
];

export function MembersView({ currentUserId, canManage }: { currentUserId: string; canManage: boolean }) {
  const [members, setMembers] = useState<InstanceMember[]>([]);
  const [invitations, setInvitations] = useState<InstanceInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", role: "member" as Role });

  // 确认对话框状态
  const [revokingInvitation, setRevokingInvitation] = useState<InstanceInvitation | null>(null);
  const [removingMember, setRemovingMember] = useState<InstanceMember | null>(null);

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

  async function handleRevokeInvitation() {
    if (!revokingInvitation) return;
    setSavingId(revokingInvitation.id); setError(null);
    try {
      await api.admin.invitations.revoke(revokingInvitation.id);
      setRevokingInvitation(null);
      await load();
    } catch (caught) { setError(caught) } finally { setSavingId(null) }
  }

  async function handleRemoveMember() {
    if (!removingMember) return;
    setSavingId(removingMember.userId); setError(null);
    try {
      await api.admin.members.update(removingMember.userId, { status: "removed" });
      setRemovingMember(null);
      await load();
    } catch (caught) { setError(caught) } finally { setSavingId(null) }
  }

  async function resendInvitation(invitation: InstanceInvitation) {
    setSavingId(invitation.id); setError(null);
    try { await api.admin.invitations.resend(invitation.id); await load() } catch (caught) { setError(caught) } finally { setSavingId(null) }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="团队与协作"
        title="团队成员"
        description="管理当前工作空间的成员账号与角色权限，支持发起邀请及状态管理。"
        action={
          <div className="button-row">
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              <RefreshCw className="size-4" />刷新
            </Button>
            {canManage ? (
              <Button onClick={() => setInviteOpen(true)}>
                <MailPlus className="size-4" />邀请成员
              </Button>
            ) : null}
          </div>
        }
      />
      <ErrorPanel error={error} />
      {loading && members.length + invitations.length === 0 ? <LoadingState /> : (
        <>
          <Card>
            <div className="card-header">
              <div>
                <p className="eyebrow">空间成员</p>
                <h2>已加入成员</h2>
                <p>工作空间所有者 (Owner) 可配置成员角色、暂停或移除成员访问权限。</p>
              </div>
              <Badge>{members.length}</Badge>
            </div>
            {members.length === 0 ? (
              <EmptyState title="暂无成员" description="空间所有者应在此处展示。" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>成员姓名 / 邮箱</th>
                      <th>角色权限</th>
                      <th>状态</th>
                      <th>加入时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member) => {
                      const isCurrent = member.userId === currentUserId;
                      return (
                        <tr key={member.userId}>
                          <td>
                            <strong>{member.user.name}{isCurrent ? "（当前用户）" : ""}</strong>
                            <small>{member.user.email}</small>
                          </td>
                          <td>
                            {canManage ? (
                              <Select
                                aria-label={`${member.user.email} 的角色`}
                                value={member.role}
                                disabled={savingId === member.userId || member.status === "removed"}
                                onChange={(event) => void updateMember(member, { role: event.target.value as Role })}
                              >
                                {roles.map((r) => (
                                  <option key={r.key} value={r.key}>{r.label}</option>
                                ))}
                              </Select>
                            ) : (
                              <Badge>{roles.find((r) => r.key === member.role)?.label || member.role}</Badge>
                            )}
                          </td>
                          <td><StatusBadge status={member.status} /></td>
                          <td>{formatDate(member.createdAt)}</td>
                          <td>
                            {canManage && member.status !== "removed" ? (
                              <div className="button-row wrap">
                                {member.status === "active" ? (
                                  <Button
                                    variant="secondary"
                                    loading={savingId === member.userId}
                                    onClick={() => void updateMember(member, { status: "disabled" })}
                                  >
                                    暂停
                                  </Button>
                                ) : (
                                  <Button
                                    variant="secondary"
                                    loading={savingId === member.userId}
                                    onClick={() => void updateMember(member, { status: "active" })}
                                  >
                                    恢复
                                  </Button>
                                )}
                                <Button
                                  variant="danger"
                                  loading={savingId === member.userId}
                                  onClick={() => setRemovingMember(member)}
                                >
                                  <UserMinus className="size-4" />移除
                                </Button>
                              </div>
                            ) : member.status === "removed" ? (
                              <small>已移除（需重新邀请）</small>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <div className="card-header">
              <div>
                <p className="eyebrow">邀请记录</p>
                <h2>待加入邀请</h2>
                <p>通过邮件发送的空间邀请。重新发送将作废旧邀请链接并生成新的安全链接。</p>
              </div>
              <Badge>{invitations.length}</Badge>
            </div>
            {invitations.length === 0 ? (
              <EmptyState title="暂无待加入邀请" description="可以通过上方“邀请成员”按钮向团队成员发送邀请邮件。" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>受邀邮箱</th>
                      <th>分配角色</th>
                      <th>状态</th>
                      <th>邮件投递</th>
                      <th>链接有效期</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((invitation) => (
                      <tr key={invitation.id}>
                        <td>
                          <strong>{invitation.email}</strong>
                          <small>{formatDate(invitation.createdAt)}</small>
                        </td>
                        <td><Badge>{roles.find((r) => r.key === invitation.role)?.label || invitation.role}</Badge></td>
                        <td><StatusBadge status={invitation.status} /></td>
                        <td><StatusBadge status={invitation.delivery?.status} /></td>
                        <td>{formatDate(invitation.expiresAt)}</td>
                        <td>
                          {canManage && invitation.status === "pending" ? (
                            <div className="button-row wrap">
                              <Button
                                variant="secondary"
                                loading={savingId === invitation.id}
                                onClick={() => void resendInvitation(invitation)}
                              >
                                <RotateCw className="size-4" />重发
                              </Button>
                              <Button
                                variant="danger"
                                loading={savingId === invitation.id}
                                onClick={() => setRevokingInvitation(invitation)}
                              >
                                撤销
                              </Button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="邀请新成员" description="受邀人将收到邀请邮件，通过邮件安全链接自行设置密码并加入当前空间。">
        <form className="form-stack" onSubmit={invite}>
          <Field label="成员邮箱">
            <Input
              type="email"
              value={inviteForm.email}
              onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}
              placeholder="colleague@example.com"
              autoComplete="email"
              required
            />
          </Field>
          <Field label="分配角色">
            <Select
              value={inviteForm.role}
              onChange={(event) => setInviteForm({ ...inviteForm, role: event.target.value as Role })}
            >
              {roles.map((r) => (
                <option key={r.key} value={r.key}>{r.label}</option>
              ))}
            </Select>
          </Field>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setInviteOpen(false)}>取消</Button>
            <Button type="submit" loading={savingId === "invite"}>发送邀请</Button>
          </div>
        </form>
      </Modal>

      {/* 撤销邀请确认 */}
      <ConfirmModal
        open={Boolean(revokingInvitation)}
        onClose={() => setRevokingInvitation(null)}
        onConfirm={() => void handleRevokeInvitation()}
        loading={savingId === revokingInvitation?.id}
        title="撤销成员邀请"
        description={`确定撤销发给 ${revokingInvitation?.email || ""} 的邀请链接？撤销后该链接将立即失效。`}
        confirmText="确认撤销"
        danger
      />

      {/* 移除成员确认 */}
      <ConfirmModal
        open={Boolean(removingMember)}
        onClose={() => setRemovingMember(null)}
        onConfirm={() => void handleRemoveMember()}
        loading={savingId === removingMember?.userId}
        title="移除团队成员"
        description={`确定从当前空间移除成员 ${removingMember?.user.email || ""}？移除后该成员将无法访问本空间，重新加入需要重新发送邀请。`}
        confirmText="确认移除"
        danger
      />
    </div>
  );
}
