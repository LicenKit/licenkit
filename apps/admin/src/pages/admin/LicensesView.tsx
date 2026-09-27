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
  formatDurationSeconds,
} from "../../components/ui";
import { useI18n } from "../../lib/i18n";

export function LicensesView({ canManage, canSupport }: { canManage: boolean; canSupport: boolean }) {
  const { t, formatDate } = useI18n();
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
        eyebrow={t.licenses.eyebrow}
        title={t.licenses.title}
        description={t.licenses.description}
        action={
          <div className="button-row">
            <Button variant="secondary" loading={loading} onClick={() => void loadLicenses(page)}>
              <RefreshCw className="size-4" />{t.common.refresh}
            </Button>
            {canManage ? (
              <Button onClick={() => setIssueModal(true)}>
                <Plus className="size-4" />{t.licenses.issueLicense}
              </Button>
            ) : null}
          </div>
        }
      />
      <ErrorPanel error={error} onClose={() => setError(null)} />

      {revealedKey ? (
        <div className="credential-reveal">
          <div>
            <p className="eyebrow">{t.licenses.modalOneTimeTitle}</p>
            <h2>{t.licenses.modalOneTimeDesc}</h2>
            <p>{t.licenses.tableColStatus}：<StatusBadge status={resultDelivery?.status} /></p>
          </div>
          <code>{revealedKey}</code>
          <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(revealedKey)}>
            <Copy className="size-4" />{t.common.copy}
          </Button>
          <Button variant="ghost" onClick={() => setOneTimeResult(null)}>{t.common.confirm}</Button>
        </div>
      ) : null}

      <Card>
        {/* 顶部下推过滤栏 */}
        <div className="filter-bar">
          <form className="filter-group" onSubmit={handleSearchSubmit}>
            <div className="filter-search">
              <Input
                placeholder={t.licenses.filterSearchPlaceholder}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            <Button variant="secondary" type="submit">
              <Search className="size-4" />{t.common.search}
            </Button>
          </form>

          <div className="filter-group">
            <Select
              className="filter-select"
              aria-label={t.licenses.filterAllProducts}
              value={filterProductId}
              onChange={(event) => setFilterProductId(event.target.value)}
            >
              <option value="">{t.licenses.filterAllProducts}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>

            <Select
              className="filter-select"
              aria-label={t.licenses.filterAllStatuses}
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value)}
            >
              <option value="">{t.licenses.filterAllStatuses}</option>
              <option value="active">{t.licenses.filterStatusActive}</option>
              <option value="suspended">{t.licenses.filterStatusSuspended}</option>
              <option value="revoked">{t.licenses.filterStatusRevoked}</option>
              <option value="expired">{t.licenses.filterStatusExpired}</option>
            </Select>
          </div>
        </div>

        {loading && licenses.length === 0 ? (
          <LoadingState />
        ) : licenses.length === 0 ? (
          <EmptyState
            title={t.licenses.emptyTitle}
            description={t.licenses.emptyDesc}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t.licenses.tableColLicense}</th>
                    <th>{t.licenses.tableColProductPlan}</th>
                    <th>{t.licenses.tableColCustomer}</th>
                    <th>{t.licensePlans.fieldModel}</th>
                    <th>{t.licenses.tableColStatus}</th>
                    <th>{t.licenses.tableColActivations}</th>
                    <th>{t.licenses.tableColExpiresAt}</th>
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
                          <Badge tone="warning">Sandbox</Badge>
                        ) : null}
                      </td>
                      <td>
                        <strong>{license.productName || license.productId}</strong>
                      </td>
                      <td>
                        <span>{license.customerEmail || license.customerId}</span>
                      </td>
                      <td>
                        <span>{license.licenseModel === "perpetual" ? t.licensePlans.modelPerpetual : license.licenseModel === "fixed_term" ? t.licensePlans.modelFixedTerm : t.licensePlans.modelSubscription}</span>
                        <small>{license.renewalMode === "billing" ? "Paddle" : "Manual"}</small>
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
                          {t.common.details}
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
        title={detail?.productName || detail?.productId || t.licenses.drawerTitle}
        description={detail ? `${t.licenses.tableColLicense}：${detail.id}` : undefined}
        wide
      >
        {detail ? (
          <div className="detail-stack">
            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">{t.licenses.drawerEyebrow}</p>
                  <h2>{detail.productName || detail.productId}</h2>
                  <p className="mono">{detail.id}</p>
                </div>
                <div className="button-row">
                  <StatusBadge status={detail.status} />
                  {detail.isCheckoutVerification ? <Badge tone="warning">Sandbox</Badge> : null}
                </div>
              </div>
              <div className="metric-grid compact">
                <div><span>{t.licenses.tableColCustomer}</span><strong>{detail.customerEmail || detail.customerId}</strong></div>
                <div><span>{t.licensePlans.fieldModel}</span><strong>{detail.licenseModel === "perpetual" ? t.licensePlans.modelPerpetual : detail.licenseModel === "fixed_term" ? t.licensePlans.modelFixedTerm : t.licensePlans.modelSubscription}</strong></div>
                <div><span>{t.licenses.tableColExpiresAt}</span><strong>{formatDate(detail.expiresAt)}</strong></div>
                <div><span>{t.licenses.detailUpdatesUntil}</span><strong>{detail.updatesUntil ? formatDate(detail.updatesUntil) : t.licenses.neverExpires}</strong></div>
                <div><span>{t.licenses.detailActivations}</span><strong>{detail.activeActivations ?? activations.filter((item) => item.status === "active").length} / {detail.maxActivations ?? detail.terms?.maxActivations ?? "—"}</strong></div>
                <div><span>{t.licenses.tableColStatus}</span><strong><StatusBadge status={detail.delivery?.status} /></strong></div>
              </div>

              <div className="terms-panel">
                <div>
                  <strong>{t.licenses.detailSectionGeneral}</strong>
                  <span>{t.licenses.detailPlan} {detail.licensePlanId || detail.terms?.sourceLicensePlanId || "—"} · {t.licenses.detailPlanRevision(detail.planRevision ?? detail.terms?.sourceLicensePlanRevision ?? 1)}</span>
                </div>
                <dl>
                  <div><dt>{t.licensePlans.fieldCredentialMode}</dt><dd>{detail.credentialMode ?? detail.terms?.credentialMode ?? "—"}</dd></div>
                  <div><dt>{t.licensePlans.graceSecondsLabel}</dt><dd>{formatDurationSeconds(detail.paymentGraceSeconds ?? detail.terms?.paymentGraceSeconds)}</dd></div>
                  <div><dt>{t.licensePlans.tokenTtlLabel}</dt><dd>{formatDurationSeconds(detail.signedTokenTtlSeconds ?? detail.terms?.signedTokenTtlSeconds)}</dd></div>
                  <div><dt>{t.licensePlans.fieldFeatures}</dt><dd>{(detail.features ?? detail.terms?.features ?? []).join(", ") || t.licensePlans.noFeatures}</dd></div>
                </dl>
              </div>

              {canManage ? (
                <div className="button-row wrap">
                  <Button variant="secondary" loading={saving} onClick={() => setConfirmRotate("recover")}>
                    <RotateCw className="size-4" />{t.licenses.btnRotateKey}
                  </Button>
                  <Button variant="danger" loading={saving} onClick={() => setConfirmRotate("reset")}>
                    <ShieldAlert className="size-4" />{t.licenses.btnRotateKeyReset}
                  </Button>
                  {detail.status === "active" ? (
                    <Button variant="secondary" onClick={() => setStateActionModal({ action: "suspend", reason: "" })}>
                      <PauseCircle className="size-4" />{t.licenses.modalStateActionTitle("suspend")}
                    </Button>
                  ) : detail.status === "suspended" && !detail.isCheckoutVerification ? (
                    <Button variant="secondary" onClick={() => setStateActionModal({ action: "reinstate", reason: "" })}>
                      <ShieldCheck className="size-4" />{t.licenses.modalStateActionTitle("reinstate")}
                    </Button>
                  ) : null}
                  {detail.status !== "revoked" ? (
                    <Button variant="danger" onClick={() => setStateActionModal({ action: "revoke", reason: "" })}>
                      <Ban className="size-4" />{t.licenses.modalStateActionTitle("revoke")}
                    </Button>
                  ) : null}
                  {detail.licenseModel === "subscription" && detail.renewalMode === "manual" ? (
                    <Button variant="secondary" onClick={() => setRenewModal({ expiresAt: "", reason: "" })}>
                      <TimerReset className="size-4" />{t.licenses.btnRenew}
                    </Button>
                  ) : null}
                  {detail.licenseModel === "perpetual" ? (
                    <Button variant="secondary" onClick={() => setExtendModal({ mode: "never", updatesUntil: "", reason: "" })}>
                      {t.licenses.btnExtendUpdates}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </Card>

            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">{t.licenses.activationsSectionTitle}</p>
                  <h2>{t.licenses.activationsSectionTitle}</h2>
                  <p>{t.licenses.activationsSectionDesc}</p>
                </div>
                <Badge>{activations.length}</Badge>
              </div>
              {activations.length === 0 ? (
                <EmptyState title={t.licenses.activationsEmptyTitle} description={t.licenses.activationsEmptyDesc} />
              ) : (
                <div className="stack-list">
                  {activations.map((activation) => (
                    <div className="stack-row" key={activation.id}>
                      <Laptop className="size-5" />
                      <div className="grow">
                        <strong>{activation.name || activation.id}</strong>
                        <span>{activation.platform || "—"} · {t.licenses.tableColLastSeenAt} {formatDate(activation.lastValidatedAt)}</span>
                      </div>
                      <StatusBadge status={activation.status} />
                      {canSupport && activation.status === "active" ? (
                        <Button
                          variant="secondary"
                          onClick={() => setRevokeActivationTarget({ activation, reason: "" })}
                        >
                          {t.licenses.btnRevokeActivation}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        ) : (
          <LoadingState />
        )}
      </Drawer>

      {/* 手动签发 Modal */}
      <Modal open={issueModal} onClose={() => setIssueModal(false)} title={t.licenses.modalIssueTitle} description={t.licenses.modalIssueDesc}>
        <form className="form-stack" onSubmit={issue}>
          <Field label={t.licenses.fieldSelectPlan}>
            <Select
              value={issueForm.licensePlanId}
              onChange={(event) => setIssueForm({ ...issueForm, licensePlanId: event.target.value })}
              required
            >
              {plans.filter((plan) => plan.status === "active").map((plan) => (
                <option key={plan.id} value={plan.id}>{plan.name} · {plan.licenseModel === "subscription" ? t.licensePlans.modelSubscription : plan.licenseModel === "fixed_term" ? t.licensePlans.modelFixedTerm : t.licensePlans.modelPerpetual}</option>
              ))}
            </Select>
          </Field>
          <Field label={t.licenses.fieldCustomerEmail}>
            <Input
              type="email"
              value={issueForm.customerEmail}
              onChange={(event) => setIssueForm({ ...issueForm, customerEmail: event.target.value })}
              placeholder="customer@example.com"
              required
            />
          </Field>
          {issuePlan?.licenseModel === "subscription" ? (
            <Field label={t.licenses.fieldExpiresAt} hint={t.licenses.fieldExpiresAtHint}>
              <Input
                type="datetime-local"
                value={issueForm.expiresAt}
                onChange={(event) => setIssueForm({ ...issueForm, expiresAt: event.target.value })}
                required
              />
            </Field>
          ) : null}
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setIssueModal(false)}>{t.common.cancel}</Button>
            <Button type="submit" loading={saving}>{t.licenses.btnIssueSubmit}</Button>
          </div>
        </form>
      </Modal>

      {/* 状态操作 Modal（暂停/恢复/吊销） */}
      <Modal
        open={Boolean(stateActionModal)}
        onClose={() => setStateActionModal(null)}
        title={stateActionModal ? t.licenses.modalStateActionTitle(stateActionModal.action) : ""}
        description={stateActionModal ? t.licenses.modalStateActionDesc(stateActionModal.action) : ""}
      >
        {stateActionModal ? (
          <form className="form-stack" onSubmit={executeStateAction}>
            <Field label={t.licenses.fieldReason} hint={stateActionModal ? t.licenses.modalStateActionDesc(stateActionModal.action) : undefined}>
              <Textarea
                value={stateActionModal.reason}
                onChange={(event) => setStateActionModal({ ...stateActionModal, reason: event.target.value })}
                placeholder="Reason..."
                required
              />
            </Field>
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setStateActionModal(null)}>{t.common.cancel}</Button>
              <Button variant={stateActionModal.action === "revoke" ? "danger" : "primary"} type="submit" loading={saving}>
                {t.licenses.modalStateActionTitle(stateActionModal.action)}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* 手动续期 Modal */}
      <Modal
        open={Boolean(renewModal)}
        onClose={() => setRenewModal(null)}
        title={t.licenses.modalRenewTitle}
        description={t.licenses.modalRenewDesc}
      >
        {renewModal ? (
          <form className="form-stack" onSubmit={executeRenew}>
            <Field label={t.licenses.fieldExpiresAt}>
              <Input
                type="datetime-local"
                value={renewModal.expiresAt}
                onChange={(event) => setRenewModal({ ...renewModal, expiresAt: event.target.value })}
                required
              />
            </Field>
            <Field label={t.licenses.fieldReason}>
              <Input
                value={renewModal.reason}
                onChange={(event) => setRenewModal({ ...renewModal, reason: event.target.value })}
                required
              />
            </Field>
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setRenewModal(null)}>{t.common.cancel}</Button>
              <Button type="submit" loading={saving}>{t.common.confirm}</Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* 延长版本更新权益 Modal */}
      <Modal
        open={Boolean(extendModal)}
        onClose={() => setExtendModal(null)}
        title={t.licenses.modalExtendTitle}
        description={t.licenses.modalExtendDesc}
      >
        {extendModal ? (
          <form className="form-stack" onSubmit={executeExtendUpdates}>
            <Field label={t.licenses.modalExtendTitle}>
              <Select
                value={extendModal.mode}
                onChange={(event) => setExtendModal({ ...extendModal, mode: event.target.value as "never" | "custom" })}
              >
                <option value="never">{t.licenses.extendModeNever}</option>
                <option value="custom">{t.licenses.extendModeCustom}</option>
              </Select>
            </Field>
            {extendModal.mode === "custom" ? (
              <Field label={t.licenses.detailUpdatesUntil}>
                <Input
                  type="datetime-local"
                  value={extendModal.updatesUntil}
                  onChange={(event) => setExtendModal({ ...extendModal, updatesUntil: event.target.value })}
                  required
                />
              </Field>
            ) : null}
            <Field label={t.licenses.fieldReason}>
              <Input
                value={extendModal.reason}
                onChange={(event) => setExtendModal({ ...extendModal, reason: event.target.value })}
                required
              />
            </Field>
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setExtendModal(null)}>{t.common.cancel}</Button>
              <Button type="submit" loading={saving}>{t.common.confirm}</Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* 吊销激活设备 Modal */}
      <Modal
        open={Boolean(revokeActivationTarget)}
        onClose={() => setRevokeActivationTarget(null)}
        title={t.licenses.modalRevokeActivationTitle}
        description={revokeActivationTarget ? t.licenses.modalRevokeActivationDesc(revokeActivationTarget.activation.name || revokeActivationTarget.activation.id) : ""}
      >
        {revokeActivationTarget ? (
          <form className="form-stack" onSubmit={executeRevokeActivation}>
            <Field label={t.licenses.fieldReason}>
              <Input
                value={revokeActivationTarget.reason}
                onChange={(event) => setRevokeActivationTarget({ ...revokeActivationTarget, reason: event.target.value })}
                required
              />
            </Field>
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setRevokeActivationTarget(null)}>{t.common.cancel}</Button>
              <Button variant="danger" type="submit" loading={saving}>{t.licenses.btnRevokeActivation}</Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <ConfirmModal
        open={Boolean(confirmRotate)}
        onClose={() => setConfirmRotate(null)}
        onConfirm={() => void handleConfirmRotate()}
        loading={saving}
        title={confirmRotate ? t.licenses.modalRotateConfirmTitle(confirmRotate) : ""}
        description={confirmRotate ? t.licenses.modalRotateConfirmDesc(confirmRotate) : ""}
        confirmText={confirmRotate === "recover" ? t.licenses.btnRotateKey : t.licenses.btnRotateKeyReset}
        danger={confirmRotate === "reset"}
      />
    </div>
  );
}
