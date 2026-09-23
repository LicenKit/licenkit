import { useEffect, useState, type FormEvent } from "react";
import {
  Ban,
  Copy,
  KeyRound,
  Laptop,
  PauseCircle,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import {
  api,
  type Activation,
  type IssuedLicenseResponse,
  type KeyRotationResponse,
  type License,
  type LicensePlan,
  type Product,
} from "../../lib/api-client";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  Drawer,
  EmptyState,
  ErrorPanel,
  Field,
  Input,
  LoadingState,
  Modal,
  Notice,
  PageHeader,
  PaginationBar,
  Select,
  StatusBadge,
  Textarea,
  formatDate,
  formatDurationSeconds,
} from "../../components/ui";

export function LicensesView({ canManage, canSupport }: { canManage: boolean; canSupport: boolean }) {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [plans, setPlans] = useState<LicensePlan[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<License | null>(null);
  const [activations, setActivations] = useState<Activation[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // 分页与过滤状态
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [filterProductId, setFilterProductId] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // 手动签发 Modal
  const [issueModal, setIssueModal] = useState(false);
  const [issueForm, setIssueForm] = useState({ licensePlanId: "", customerEmail: "", expiresAt: "" });
  const [oneTimeResult, setOneTimeResult] = useState<IssuedLicenseResponse | KeyRotationResponse | null>(null);

  // 安全操作 Modal 状态
  const [confirmRotate, setConfirmRotate] = useState<"recover" | "reset" | null>(null);
  const [stateActionModal, setStateActionModal] = useState<{ action: "suspend" | "reinstate" | "revoke"; reason: string } | null>(null);
  const [renewModal, setRenewModal] = useState<{ expiresAt: string; reason: string } | null>(null);
  const [extendModal, setExtendModal] = useState<{ mode: "never" | "custom"; updatesUntil: string; reason: string } | null>(null);
  const [revokeActivationTarget, setRevokeActivationTarget] = useState<{ activation: Activation; reason: string } | null>(null);

  async function loadInitialData() {
    try {
      const [planResult, productResult] = await Promise.all([
        api.admin.licensePlans.list(),
        api.admin.products.list(),
      ]);
      setPlans(planResult.items);
      setProducts(productResult.items);
      setIssueForm((current) => ({
        ...current,
        licensePlanId: current.licensePlanId || planResult.items.find((item) => item.status === "active")?.id || "",
      }));
    } catch (caught) {
      setError(caught);
    }
  }

  async function loadLicenses(targetPage = page) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.admin.licenses.list({
        page: targetPage,
        limit: 20,
        productId: filterProductId || undefined,
        status: filterStatus || undefined,
        query: searchQuery.trim() || undefined,
      });
      setLicenses(result.items);
      if (result.pagination) {
        setPage(result.pagination.page);
        setTotalPages(result.pagination.totalPages);
        setTotalItems(result.pagination.total);
      } else {
        setPage(targetPage);
        setTotalPages(1);
        setTotalItems(result.items.length);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(id: string) {
    setError(null);
    try {
      const [licenseResult, activationResult] = await Promise.all([
        api.admin.licenses.get(id),
        api.admin.licenses.activations(id),
      ]);
      setDetail(licenseResult);
      setActivations(activationResult.items);
    } catch (caught) {
      setError(caught);
    }
  }

  useEffect(() => {
    void loadInitialData();
  }, []);

  useEffect(() => {
    void loadLicenses(1);
  }, [filterProductId, filterStatus]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else {
      setDetail(null);
      setActivations([]);
    }
  }, [selectedId]);

  function handleSearchSubmit(event: FormEvent) {
    event.preventDefault();
    void loadLicenses(1);
  }

  const issuePlan = plans.find((plan) => plan.id === issueForm.licensePlanId);

  async function issue(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api.admin.licenses.issue({
        licensePlanId: issueForm.licensePlanId,
        customerEmail: issueForm.customerEmail.trim(),
        expiresAt: issuePlan?.licenseModel === "subscription" ? new Date(issueForm.expiresAt).toISOString() : null,
        delivery: { sendNotification: true },
      });
      setOneTimeResult(result);
      setIssueModal(false);
      setIssueForm({ licensePlanId: issueForm.licensePlanId, customerEmail: "", expiresAt: "" });
      await loadLicenses(1);
      setSelectedId(result.license.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmRotate() {
    if (!detail || !confirmRotate) return;
    const kind = confirmRotate;
    setSaving(true);
    setError(null);
    try {
      const result = kind === "recover"
        ? await api.admin.licenses.recoverKey(detail.id)
        : await api.admin.licenses.securityReset(detail.id);
      setOneTimeResult(result);
      setConfirmRotate(null);
      await loadDetail(detail.id);
      await loadLicenses(page);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function executeStateAction(event: FormEvent) {
    event.preventDefault();
    if (!detail || !stateActionModal) return;
    setSaving(true);
    setError(null);
    try {
      const { action, reason } = stateActionModal;
      if (action === "suspend") await api.admin.licenses.suspend(detail.id, reason.trim());
      else if (action === "reinstate") await api.admin.licenses.reinstate(detail.id, reason.trim());
      else if (action === "revoke") await api.admin.licenses.revoke(detail.id, reason.trim());
      setStateActionModal(null);
      await loadDetail(detail.id);
      await loadLicenses(page);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function executeRenew(event: FormEvent) {
    event.preventDefault();
    if (!detail || !renewModal) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.licenses.renewTerm(
        detail.id,
        new Date(renewModal.expiresAt).toISOString(),
        renewModal.reason.trim(),
      );
      setRenewModal(null);
      await loadDetail(detail.id);
      await loadLicenses(page);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function executeExtendUpdates(event: FormEvent) {
    event.preventDefault();
    if (!detail || !extendModal) return;
    setSaving(true);
    setError(null);
    try {
      const value = extendModal.mode === "never" ? null : new Date(extendModal.updatesUntil).toISOString();
      await api.admin.licenses.extendUpdates(detail.id, value, extendModal.reason.trim());
      setExtendModal(null);
      await loadDetail(detail.id);
      await loadLicenses(page);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function executeRevokeActivation(event: FormEvent) {
    event.preventDefault();
    if (!detail || !revokeActivationTarget) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.licenses.revokeActivation(
        detail.id,
        revokeActivationTarget.activation.id,
        revokeActivationTarget.reason.trim(),
      );
      setRevokeActivationTarget(null);
      await loadDetail(detail.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  const revealedKey = oneTimeResult
    ? "licenseKey" in oneTimeResult
      ? oneTimeResult.licenseKey
      : oneTimeResult.license.licenseKey
    : null;
  const resultDelivery = oneTimeResult?.delivery ?? null;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="授权运营"
        title="授权管理"
        description="管理系统已签发的授权合同、激活设备、有效期限及安全生命周期状态。"
        action={
          <div className="button-row">
            <Button variant="secondary" loading={loading} onClick={() => void loadLicenses(page)}>
              <RefreshCw className="size-4" />刷新
            </Button>
            {canManage ? (
              <Button onClick={() => setIssueModal(true)}>
                <Plus className="size-4" />手动签发
              </Button>
            ) : null}
          </div>
        }
      />
      <ErrorPanel error={error} />

      {revealedKey ? (
        <div className="credential-reveal">
          <div>
            <p className="eyebrow">仅显示一次</p>
            <h2>注册码已生成</h2>
            <p>通知状态：<StatusBadge status={resultDelivery?.status} /></p>
          </div>
          <code>{revealedKey}</code>
          <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(revealedKey)}>
            <Copy className="size-4" />复制注册码
          </Button>
          <Button variant="ghost" onClick={() => setOneTimeResult(null)}>我已保存</Button>
        </div>
      ) : null}

      <Card>
        {/* 顶部下推过滤栏 */}
        <div className="filter-bar">
          <form className="filter-group" onSubmit={handleSearchSubmit}>
            <div className="filter-search">
              <Input
                placeholder="搜索授权编号或客户..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            <Button variant="secondary" type="submit">
              <Search className="size-4" />搜索
            </Button>
          </form>

          <div className="filter-group">
            <Select
              className="filter-select"
              aria-label="按产品过滤"
              value={filterProductId}
              onChange={(event) => setFilterProductId(event.target.value)}
            >
              <option value="">全部产品</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>

            <Select
              className="filter-select"
              aria-label="按状态过滤"
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value)}
            >
              <option value="">全部状态</option>
              <option value="active">生效中</option>
              <option value="suspended">已暂停</option>
              <option value="revoked">已吊销</option>
              <option value="expired">已过期</option>
            </Select>
          </div>
        </div>

        {loading && licenses.length === 0 ? (
          <LoadingState label="正在加载授权数据" />
        ) : licenses.length === 0 ? (
          <EmptyState
            title="未找到匹配的授权"
            description="可以更换过滤条件重试，或点击右上角手动签发。"
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>授权编号</th>
                    <th>产品</th>
                    <th>客户</th>
                    <th>授权模型</th>
                    <th>状态</th>
                    <th>激活数</th>
                    <th>到期时间</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {licenses.map((license) => (
                    <tr
                      key={license.id}
                      className="clickable-row"
                      onClick={() => setSelectedId(license.id)}
                    >
                      <td>
                        <strong>{license.id}</strong>
                        {license.isCheckoutVerification ? (
                          <Badge tone="warning">沙盒结账验证</Badge>
                        ) : null}
                      </td>
                      <td>
                        <strong>{license.productName || license.productId}</strong>
                      </td>
                      <td>
                        <span>{license.customerEmail || license.customerId}</span>
                      </td>
                      <td>
                        <span>{license.licenseModel === "perpetual" ? "永久买断" : license.licenseModel === "fixed_term" ? "固定期限" : "周期订阅"}</span>
                        <small>{license.renewalMode === "billing" ? "自动续费" : "手动续期"}</small>
                      </td>
                      <td>
                        <StatusBadge status={license.status} />
                      </td>
                      <td>
                        <strong>{license.activeActivations ?? "0"} / {license.maxActivations ?? "—"}</strong>
                      </td>
                      <td>
                        <span>{formatDate(license.expiresAt)}</span>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          onClick={() => setSelectedId(license.id)}
                        >
                          详情
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <PaginationBar
              page={page}
              totalPages={totalPages}
              totalItems={totalItems}
              onPageChange={(newPage) => void loadLicenses(newPage)}
              loading={loading}
            />
          </>
        )}
      </Card>

      {/* 详情抽屉 Drawer */}
      <Drawer
        open={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        title={detail?.productName || detail?.productId || "授权详情"}
        description={detail ? `授权编号：${detail.id}` : undefined}
        wide
      >
        {detail ? (
          <div className="detail-stack">
            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">授权概要</p>
                  <h2>{detail.productName || detail.productId}</h2>
                  <p className="mono">{detail.id}</p>
                </div>
                <div className="button-row">
                  <StatusBadge status={detail.status} />
                  {detail.isCheckoutVerification ? <Badge tone="warning">沙盒结账验证</Badge> : null}
                </div>
              </div>
              <div className="metric-grid compact">
                <div><span>客户</span><strong>{detail.customerEmail || detail.customerId}</strong></div>
                <div><span>授权模式 / 续期</span><strong>{detail.licenseModel === "perpetual" ? "永久买断" : detail.licenseModel === "fixed_term" ? "固定期限" : "周期订阅"} · {detail.renewalMode === "billing" ? "自动续费" : "手动续期"}</strong></div>
                <div><span>到期时间</span><strong>{formatDate(detail.expiresAt)}</strong></div>
                <div><span>更新权益截止</span><strong>{detail.updatesUntil ? formatDate(detail.updatesUntil) : "永久有效"}</strong></div>
                <div><span>激活设备数</span><strong>{detail.activeActivations ?? activations.filter((item) => item.status === "active").length} / {detail.maxActivations ?? detail.terms?.maxActivations ?? "—"}</strong></div>
                <div><span>首次通知状态</span><strong><StatusBadge status={detail.delivery?.status} /></strong></div>
              </div>

              <div className="terms-panel">
                <div>
                  <strong>生效条款</strong>
                  <span>来源方案 {detail.licensePlanId || detail.terms?.sourceLicensePlanId || "—"} · 版本 {detail.planRevision ?? detail.terms?.sourceLicensePlanRevision ?? "—"}</span>
                </div>
                <dl>
                  <div><dt>签名验证模式</dt><dd>{detail.credentialMode ?? detail.terms?.credentialMode ?? "—"}</dd></div>
                  <div><dt>扣费宽限期</dt><dd>{formatDurationSeconds(detail.paymentGraceSeconds ?? detail.terms?.paymentGraceSeconds)}</dd></div>
                  <div><dt>离线凭据有效期</dt><dd>{formatDurationSeconds(detail.signedTokenTtlSeconds ?? detail.terms?.signedTokenTtlSeconds)}</dd></div>
                  <div><dt>功能特性开关</dt><dd>{(detail.features ?? detail.terms?.features ?? []).join(", ") || "未配置特殊特性"}</dd></div>
                </dl>
              </div>

              {canManage ? (
                <div className="button-row wrap">
                  <Button variant="secondary" loading={saving} onClick={() => setConfirmRotate("recover")}>
                    <RotateCw className="size-4" />重新生成注册码
                  </Button>
                  <Button variant="danger" loading={saving} onClick={() => setConfirmRotate("reset")}>
                    <ShieldAlert className="size-4" />安全重置
                  </Button>
                  {detail.status === "active" ? (
                    <Button variant="secondary" onClick={() => setStateActionModal({ action: "suspend", reason: "" })}>
                      <PauseCircle className="size-4" />暂停授权
                    </Button>
                  ) : detail.status === "suspended" && !detail.isCheckoutVerification ? (
                    <Button variant="secondary" onClick={() => setStateActionModal({ action: "reinstate", reason: "" })}>
                      <ShieldCheck className="size-4" />恢复授权
                    </Button>
                  ) : null}
                  {detail.status !== "revoked" ? (
                    <Button variant="danger" onClick={() => setStateActionModal({ action: "revoke", reason: "" })}>
                      <Ban className="size-4" />吊销授权
                    </Button>
                  ) : null}
                  {detail.licenseModel === "subscription" && detail.renewalMode === "manual" ? (
                    <Button variant="secondary" onClick={() => setRenewModal({ expiresAt: "", reason: "管理员手动续期" })}>
                      <TimerReset className="size-4" />手动续期
                    </Button>
                  ) : null}
                  {detail.licenseModel === "perpetual" ? (
                    <Button variant="secondary" onClick={() => setExtendModal({ mode: "never", updatesUntil: "", reason: "延长版本更新权益" })}>
                      延长更新权益
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </Card>

            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">设备绑定</p>
                  <h2>激活设备</h2>
                  <p>管理此授权关联的客户端设备。吊销设备仅变更其激活状态，完整审计历史予以保留。</p>
                </div>
                <Badge>{activations.length}</Badge>
              </div>
              {activations.length === 0 ? (
                <EmptyState title="暂无激活设备" description="客户端使用此授权的注册码激活后，将在此处展示绑定的设备信息。" />
              ) : (
                <div className="stack-list">
                  {activations.map((activation) => (
                    <div className="stack-row" key={activation.id}>
                      <Laptop className="size-5" />
                      <div className="grow">
                        <strong>{activation.name || "未命名设备"}</strong>
                        <span>{activation.platform || "未知平台"} · 最近验证 {formatDate(activation.lastValidatedAt)}</span>
                      </div>
                      <StatusBadge status={activation.status} />
                      {canSupport && activation.status === "active" ? (
                        <Button
                          variant="secondary"
                          onClick={() => setRevokeActivationTarget({ activation, reason: "管理员吊销设备激活" })}
                        >
                          吊销激活
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        ) : (
          <LoadingState label="正在加载授权详情" />
        )}
      </Drawer>

      {/* 手动签发 Modal */}
      <Modal open={issueModal} onClose={() => setIssueModal(false)} title="手动签发授权" description="选择方案并输入客户邮箱。系统将自动建立客户档案并生成授权凭证。">
        <form className="form-stack" onSubmit={issue}>
          <Field label="授权方案">
            <Select
              value={issueForm.licensePlanId}
              onChange={(event) => setIssueForm({ ...issueForm, licensePlanId: event.target.value })}
              required
            >
              {plans.filter((plan) => plan.status === "active").map((plan) => (
                <option key={plan.id} value={plan.id}>{plan.name} · {plan.licenseModel === "subscription" ? "周期订阅" : plan.licenseModel === "fixed_term" ? "固定期限" : "永久买断"}</option>
              ))}
            </Select>
          </Field>
          <Field label="客户邮箱">
            <Input
              type="email"
              value={issueForm.customerEmail}
              onChange={(event) => setIssueForm({ ...issueForm, customerEmail: event.target.value })}
              placeholder="customer@example.com"
              required
            />
          </Field>
          {issuePlan?.licenseModel === "subscription" ? (
            <Field label="本期到期时间" hint="手动订阅模式需指定首次计费周期的到期时间">
              <Input
                type="datetime-local"
                value={issueForm.expiresAt}
                onChange={(event) => setIssueForm({ ...issueForm, expiresAt: event.target.value })}
                required
              />
            </Field>
          ) : null}
          {issuePlan?.licenseModel === "perpetual" ? (
            <Notice>
              <strong>永久授权模式</strong>
              <p>永久授权无到期时间限制，版本更新权益由方案设定的更新期控制。</p>
            </Notice>
          ) : null}
          <Notice tone="info">
            <strong>邮件通知发信</strong>
            <p>签发成功后将自动向客户邮箱发送包含注册码的通知邮件。若邮件发送失败，可在邮件中心查看并手动重试。</p>
          </Notice>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setIssueModal(false)}>取消</Button>
            <Button type="submit" loading={saving}>确认签发</Button>
          </div>
        </form>
      </Modal>

      {/* 状态操作 Modal（暂停/恢复/吊销） */}
      <Modal
        open={Boolean(stateActionModal)}
        onClose={() => setStateActionModal(null)}
        title={
          stateActionModal?.action === "suspend"
            ? "暂停授权"
            : stateActionModal?.action === "reinstate"
            ? "恢复授权"
            : "吊销授权"
        }
        description={
          stateActionModal?.action === "revoke"
            ? "警告：吊销是终态且不可逆操作，不能作为临时暂停使用。"
            : "请输入本次操作的原因记录。"
        }
      >
        {stateActionModal ? (
          <form className="form-stack" onSubmit={executeStateAction}>
            <Field label="操作原因" hint="必填，请简要说明调整原因（将记录在操作日志中）">
              <Textarea
                value={stateActionModal.reason}
                onChange={(event) => setStateActionModal({ ...stateActionModal, reason: event.target.value })}
                placeholder="请输入详细原因..."
                required
              />
            </Field>
            {stateActionModal.action === "revoke" ? (
              <Notice tone="warning">
                <strong>吊销影响</strong>
                <p>吊销后该授权不可再次恢复使用，客户端鉴权将立即判定失败。</p>
              </Notice>
            ) : null}
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setStateActionModal(null)}>取消</Button>
              <Button variant={stateActionModal.action === "revoke" ? "danger" : "primary"} type="submit" loading={saving}>
                确认{stateActionModal.action === "suspend" ? "暂停" : stateActionModal.action === "reinstate" ? "恢复" : "吊销"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* 手动续期 Modal */}
      <Modal
        open={Boolean(renewModal)}
        onClose={() => setRenewModal(null)}
        title="手动续期授权"
        description="新到期时间必须晚于当前到期时间和当前系统时间。"
      >
        {renewModal ? (
          <form className="form-stack" onSubmit={executeRenew}>
            <Field label="新到期时间" hint="请选择新的到期时间（按当前本地时间设置）">
              <Input
                type="datetime-local"
                value={renewModal.expiresAt}
                onChange={(event) => setRenewModal({ ...renewModal, expiresAt: event.target.value })}
                required
              />
            </Field>
            <Field label="续期原因">
              <Input
                value={renewModal.reason}
                onChange={(event) => setRenewModal({ ...renewModal, reason: event.target.value })}
                required
              />
            </Field>
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setRenewModal(null)}>取消</Button>
              <Button type="submit" loading={saving}>确认续期</Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* 延长版本更新权益 Modal */}
      <Modal
        open={Boolean(extendModal)}
        onClose={() => setExtendModal(null)}
        title="延长版本更新权益"
        description="修改永久授权允许更新软件版本的截止日期。"
      >
        {extendModal ? (
          <form className="form-stack" onSubmit={executeExtendUpdates}>
            <Field label="更新权益模式">
              <Select
                value={extendModal.mode}
                onChange={(event) => setExtendModal({ ...extendModal, mode: event.target.value as "never" | "custom" })}
              >
                <option value="never">永久享受未来所有版本更新</option>
                <option value="custom">指定新的截止时间</option>
              </Select>
            </Field>
            {extendModal.mode === "custom" ? (
              <Field label="新更新截止时间">
                <Input
                  type="datetime-local"
                  value={extendModal.updatesUntil}
                  onChange={(event) => setExtendModal({ ...extendModal, updatesUntil: event.target.value })}
                  required
                />
              </Field>
            ) : null}
            <Field label="操作原因">
              <Input
                value={extendModal.reason}
                onChange={(event) => setExtendModal({ ...extendModal, reason: event.target.value })}
                required
              />
            </Field>
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setExtendModal(null)}>取消</Button>
              <Button type="submit" loading={saving}>更新权益</Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* 吊销激活设备 Modal */}
      <Modal
        open={Boolean(revokeActivationTarget)}
        onClose={() => setRevokeActivationTarget(null)}
        title="吊销激活设备"
        description={`确定吊销设备“${revokeActivationTarget?.activation.name || revokeActivationTarget?.activation.id}”？`}
      >
        {revokeActivationTarget ? (
          <form className="form-stack" onSubmit={executeRevokeActivation}>
            <Field label="吊销原因">
              <Input
                value={revokeActivationTarget.reason}
                onChange={(event) => setRevokeActivationTarget({ ...revokeActivationTarget, reason: event.target.value })}
                required
              />
            </Field>
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setRevokeActivationTarget(null)}>取消</Button>
              <Button variant="danger" type="submit" loading={saving}>确认吊销</Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <ConfirmModal
        open={Boolean(confirmRotate)}
        onClose={() => setConfirmRotate(null)}
        onConfirm={() => void handleConfirmRotate()}
        loading={saving}
        title={confirmRotate === "recover" ? "重新生成注册码" : "安全重置授权"}
        description={
          confirmRotate === "recover"
            ? "确定为该客户重新生成注册码？新注册码将自动通过邮件发送给客户，旧注册码立即失效，当前已激活的有效设备不受影响。"
            : "警告：安全重置将生成新注册码并立即吊销所有已激活的设备。客户需在各设备上重新进行激活绑定。"
        }
        confirmText={confirmRotate === "recover" ? "确认生成并发送" : "确认安全重置"}
        danger={confirmRotate === "reset"}
      />
    </div>
  );
}
