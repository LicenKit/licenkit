import { useEffect, useState, type FormEvent } from "react";
import { MailPlus, RefreshCw, RotateCw, UserMinus } from "lucide-react";
import { api, type InstanceInvitation, type InstanceMember, type MembershipStatus, type Role } from "../../lib/api-client";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorPanel, Field, Input, LoadingState, Modal, PageHeader, Select, StatusBadge } from "../../components/ui";
import { useI18n } from "../../lib/i18n/I18nContext";

export function MembersView({ currentUserId, canManage }: { currentUserId: string; canManage: boolean }) {
  const { t, formatDate } = useI18n();
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

  const roles: { key: Role; label: string }[] = [
    { key: "owner", label: t.members.roleOwner },
    { key: "admin", label: t.members.roleAdmin },
    { key: "member", label: t.members.roleMember },
    { key: "viewer", label: t.members.roleViewer },
  ];

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
        eyebrow={t.members.eyebrow}
        title={t.members.title}
        description={t.members.description}
        action={
          <div className="button-row">
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              <RefreshCw className="size-4" />{t.common.refresh}
            </Button>
            {canManage ? (
              <Button onClick={() => setInviteOpen(true)}>
                <MailPlus className="size-4" />{t.members.inviteMember}
              </Button>
            ) : null}
          </div>
        }
      />
      <ErrorPanel error={error} onClose={() => setError(null)} />
      {loading && members.length + invitations.length === 0 ? <LoadingState /> : (
        <>
          <Card>
            <div className="card-header">
              <div>
                <p className="eyebrow">{t.members.membersEyebrow}</p>
                <h2>{t.members.membersTitle}</h2>
                <p>{t.members.membersDesc}</p>
              </div>
              <Badge>{members.length}</Badge>
            </div>
            {members.length === 0 ? (
              <EmptyState title={t.members.membersEmptyTitle} description={t.members.membersEmptyDesc} />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t.members.tableColMember}</th>
                      <th>{t.members.tableColRole}</th>
                      <th>{t.members.tableColStatus}</th>
                      <th>{t.members.tableColJoinedAt}</th>
                      <th>{t.members.tableColActions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member) => {
                      const isCurrent = member.userId === currentUserId;
                      return (
                        <tr key={member.userId}>
                          <td>
                            <strong>{member.user.name}{isCurrent ? t.members.currentUserSuffix : ""}</strong>
                            <small>{member.user.email}</small>
                          </td>
                          <td>
                            {canManage ? (
                              <Select
                                aria-label={t.members.memberRoleAriaLabel(member.user.email)}
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
                                    {t.members.btnSuspend}
                                  </Button>
                                ) : (
                                  <Button
                                    variant="secondary"
                                    loading={savingId === member.userId}
                                    onClick={() => void updateMember(member, { status: "active" })}
                                  >
                                    {t.members.btnResume}
                                  </Button>
                                )}
                                <Button
                                  variant="danger"
                                  loading={savingId === member.userId}
                                  onClick={() => setRemovingMember(member)}
                                >
                                  <UserMinus className="size-4" />{t.members.btnRemoveMember}
                                </Button>
                              </div>
                            ) : member.status === "removed" ? (
                              <small>{t.members.memberRemovedHint}</small>
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
                <p className="eyebrow">{t.members.invitationsEyebrow}</p>
                <h2>{t.members.invitationsSectionTitle}</h2>
                <p>{t.members.invitationsSectionDesc}</p>
              </div>
              <Badge>{invitations.length}</Badge>
            </div>
            {invitations.length === 0 ? (
              <EmptyState title={t.members.invitationsEmptyTitle} description={t.members.invitationsEmptyDesc} />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t.members.tableColInvitedEmail}</th>
                      <th>{t.members.tableColInvitedRole}</th>
                      <th>{t.members.tableColStatus}</th>
                      <th>{t.members.tableColEmailDelivery}</th>
                      <th>{t.members.tableColExpiresAt}</th>
                      <th>{t.members.tableColActions}</th>
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
                                <RotateCw className="size-4" />{t.members.btnResend}
                              </Button>
                              <Button
                                variant="danger"
                                loading={savingId === invitation.id}
                                onClick={() => setRevokingInvitation(invitation)}
                              >
                                {t.members.btnRevokeInvitation}
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

      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title={t.members.modalInviteTitle} description={t.members.modalInviteDesc}>
        <form className="form-stack" onSubmit={invite}>
          <Field label={t.members.fieldEmail}>
            <Input
              type="email"
              value={inviteForm.email}
              onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}
              placeholder="colleague@example.com"
              autoComplete="email"
              required
            />
          </Field>
          <Field label={t.members.fieldRole}>
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
            <Button variant="secondary" type="button" onClick={() => setInviteOpen(false)}>{t.common.cancel}</Button>
            <Button type="submit" loading={savingId === "invite"}>{t.members.btnCreateInvite}</Button>
          </div>
        </form>
      </Modal>

      {/* 撤销邀请确认 */}
      <ConfirmModal
        open={Boolean(revokingInvitation)}
        onClose={() => setRevokingInvitation(null)}
        onConfirm={() => void handleRevokeInvitation()}
        loading={savingId === revokingInvitation?.id}
        title={t.members.modalRevokeConfirmTitle}
        description={t.members.modalRevokeConfirmDesc(revokingInvitation?.email || "")}
        confirmText={t.members.modalRevokeConfirmBtn}
        danger
      />

      {/* 移除成员确认 */}
      <ConfirmModal
        open={Boolean(removingMember)}
        onClose={() => setRemovingMember(null)}
        onConfirm={() => void handleRemoveMember()}
        loading={savingId === removingMember?.userId}
        title={t.members.modalRemoveMemberTitle}
        description={t.members.modalRemoveMemberDesc(removingMember?.user.email || "")}
        confirmText={t.members.modalRemoveMemberBtn}
        danger
      />
    </div>
  );
}
