import { useEffect, useState, type FormEvent } from "react";
import {
  RefreshCw,
  Search,
  ShieldOff,
  UserRound,
  UserRoundCheck,
} from "lucide-react";
import { api, type Customer, type CustomerLicenseSummary } from "../../lib/api-client";
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
} from "../../components/ui";
import { useI18n } from "../../lib/i18n";

export function CustomersView({ canManage }: { canManage: boolean }) {
  const { t, formatDate } = useI18n();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [licenses, setLicenses] = useState<CustomerLicenseSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [licensesLoading, setLicensesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // 服务端分页与过滤状态
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  // 编辑 Modal
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "" });

  // 确认对话框状态
  const [confirmToggleStatus, setConfirmToggleStatus] = useState(false);
  const [confirmRevokeSessions, setConfirmRevokeSessions] = useState(false);

  const selected = customers.find((customer) => customer.id === selectedId) ?? null;

  async function load(targetPage = page) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.admin.customers.list({
        page: targetPage,
        limit: 20,
        status: statusFilter || undefined,
        query: searchQuery.trim() || undefined,
      });
      setCustomers(result.items);
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

  useEffect(() => {
    void load(1);
  }, [statusFilter]);

  function handleSearchSubmit(event: FormEvent) {
    event.preventDefault();
    void load(1);
  }

  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setLicenses([]);
      return;
    }
    setForm({ name: selected.name || "", email: selected.email });
    setLicenses([]);
    setLicensesLoading(true);
    api.admin.customers.get(selected.id)
      .then((result) => { if (!cancelled) setLicenses(result.licenses); })
      .catch((caught) => { if (!cancelled) setError(caught); })
      .finally(() => { if (!cancelled) setLicensesLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, selected?.updatedAt]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.customers.update(selected.id, {
        name: form.name.trim() || undefined,
        email: form.email.trim(),
      });
      setEditOpen(false);
      await load(page);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStatus() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      if (selected.status === "active") await api.admin.customers.disable(selected.id);
      else await api.admin.customers.enable(selected.id);
      setConfirmToggleStatus(false);
      await load(page);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function handleRevokeSessions() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.customers.revokeSessions(selected.id);
      setConfirmRevokeSessions(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.customers.eyebrow}
        title={t.customers.title}
        description={t.customers.description}
        action={
          <Button variant="secondary" onClick={() => void load(page)} loading={loading}>
            <RefreshCw className="size-4" />{t.common.refresh}
          </Button>
        }
      />
      <ErrorPanel error={error} onClose={() => setError(null)} />

      <Card>
        {/* 顶部过滤栏 */}
        <div className="filter-bar">
          <form className="filter-group" onSubmit={handleSearchSubmit}>
            <div className="filter-search">
              <Input
                placeholder={t.customers.filterSearchPlaceholder}
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
              aria-label={t.customers.filterAllStatuses}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">{t.customers.filterAllStatuses}</option>
              <option value="active">{t.customers.filterStatusActive}</option>
              <option value="disabled">{t.customers.filterStatusDisabled}</option>
            </Select>
          </div>
          <Badge>{t.customers.totalCustomersCount(totalItems)}</Badge>
        </div>

        {loading && customers.length === 0 ? (
          <LoadingState />
        ) : customers.length === 0 ? (
          <EmptyState
            title={totalItems === 0 && !searchQuery && !statusFilter ? t.customers.emptyTitleInitial : t.customers.emptyTitleSearch}
            description={totalItems === 0 && !searchQuery && !statusFilter ? t.customers.emptyDescInitial : t.customers.emptyDescSearch}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t.customers.tableColCustomer}</th>
                    <th>{t.customers.tableColEmail}</th>
                    <th>{t.customers.tableColStatus}</th>
                    <th>{t.customers.tableColCreatedAt}</th>
                    <th>{t.customers.tableColUpdatedAt}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((customer) => (
                    <tr
                      key={customer.id}
                      className="clickable-row"
                      onClick={() => setSelectedId(customer.id)}
                    >
                      <td>
                        <div className="button-row">
                          <span className="avatar">
                            <UserRound className="size-4" />
                          </span>
                          <div>
                            <strong>{customer.name || customer.email}</strong>
                            <small className="mono">{customer.id}</small>
                            {customer.hasSandboxLicense ? <Badge tone="warning">Sandbox</Badge> : null}
                            {customer.hasLiveLicense ? <Badge>Live</Badge> : null}
                          </div>
                        </div>
                      </td>
                      <td>
                        <span>{customer.email}</span>
                      </td>
                      <td>
                        <StatusBadge status={customer.status} />
                      </td>
                      <td>
                        <span>{formatDate(customer.createdAt)}</span>
                      </td>
                      <td>
                        <span>{formatDate(customer.updatedAt)}</span>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          onClick={() => setSelectedId(customer.id)}
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
              onPageChange={(newPage) => void load(newPage)}
              loading={loading}
            />
          </>
        )}
      </Card>

      {/* 详情抽屉 Drawer */}
      <Drawer
        open={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        title={selected?.name || selected?.email || t.customers.drawerTitle}
        description={selected ? `${t.customers.detailId}：${selected.id}` : undefined}
        wide
      >
        {selected ? (
          <div className="detail-stack">
            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">{t.customers.drawerEyebrow}</p>
                  <h2>{selected.name || selected.email}</h2>
                  <p className="mono">{selected.id}</p>
                </div>
                <StatusBadge status={selected.status} />
              </div>
              <div className="metric-grid compact">
                <div>
                  <span>{t.customers.detailEmail}</span>
                  <strong>{selected.email}</strong>
                </div>
                <div>
                  <span>{t.customers.detailLicensesCount}</span>
                  <strong>{licenses.length}</strong>
                </div>
                <div>
                  <span>{t.customers.tableColCreatedAt}</span>
                  <strong>{formatDate(selected.createdAt)}</strong>
                </div>
                <div>
                  <span>{t.customers.tableColUpdatedAt}</span>
                  <strong>{formatDate(selected.updatedAt)}</strong>
                </div>
              </div>
              {canManage ? (
                <div className="button-row wrap">
                  <Button variant="secondary" onClick={() => setEditOpen(true)}>
                    {t.customers.btnEditCustomer}
                  </Button>
                  <Button variant="secondary" loading={saving} onClick={() => setConfirmRevokeSessions(true)}>
                    <ShieldOff className="size-4" />{t.customers.btnRevokeSessions}
                  </Button>
                  <Button
                    variant={selected.status === "active" ? "danger" : "secondary"}
                    loading={saving}
                    onClick={() => setConfirmToggleStatus(true)}
                  >
                    {selected.status === "active" ? (
                      <ShieldOff className="size-4" />
                    ) : (
                      <UserRoundCheck className="size-4" />
                    )}
                    {selected.status === "active" ? t.customers.btnDisableCustomer : t.customers.btnEnableCustomer}
                  </Button>
                </div>
              ) : null}
            </Card>

            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">{t.customers.licensesSectionTitle}</p>
                  <h2>{t.customers.licensesSectionTitle}</h2>
                  <p>{t.customers.licensesSectionDesc}</p>
                </div>
                <Badge>{licenses.length}</Badge>
              </div>
              {licensesLoading ? (
                <LoadingState />
              ) : licenses.length === 0 ? (
                <EmptyState title={t.customers.licensesEmptyTitle} description={t.customers.licensesEmptyDesc} />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t.licenses.tableColProductPlan}</th>
                        <th>{t.licensePlans.fieldModel}</th>
                        <th>{t.licenses.tableColStatus}</th>
                        <th>{t.licenses.tableColExpiresAt}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {licenses.map((license) => (
                        <tr key={license.id}>
                          <td>
                            <strong>{license.productName || license.productId}</strong>
                            <small className="mono">{license.id}</small>
                            <Badge tone={license.billingEnvironment === "sandbox" ? "warning" : "neutral"}>{license.billingEnvironment === "sandbox" ? "Sandbox" : "Live"}</Badge>
                          </td>
                          <td>
                            <span>{license.licenseModel === "perpetual" ? t.licensePlans.modelPerpetual : license.licenseModel === "fixed_term" ? t.licensePlans.modelFixedTerm : t.licensePlans.modelSubscription}</span>
                            <small>{license.renewalMode === "billing" ? "Paddle" : "Manual"}</small>
                          </td>
                          <td>
                            <StatusBadge status={license.status} />
                          </td>
                          <td>
                            <span>{formatDate(license.expiresAt)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        ) : (
          <LoadingState />
        )}
      </Drawer>

      {/* 编辑客户身份 Modal */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t.customers.modalEditTitle}
        description={t.customers.modalEditDesc}
      >
        <form className="form-stack" onSubmit={save}>
          <Field label={t.customers.fieldName}>
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Name..."
            />
          </Field>
          <Field label={t.customers.fieldEmail}>
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="customer@example.com"
              required
            />
          </Field>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setEditOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={saving}>
              {t.common.save}
            </Button>
          </div>
        </form>
      </Modal>

      {/* 强制退出登录确认 */}
      <ConfirmModal
        open={confirmRevokeSessions}
        onClose={() => setConfirmRevokeSessions(false)}
        onConfirm={() => void handleRevokeSessions()}
        loading={saving}
        title={t.customers.modalRevokeSessionsTitle}
        description={t.customers.modalRevokeSessionsDesc(selected?.email || "")}
        confirmText={t.customers.btnRevokeSessions}
        danger
      />

      {/* 禁用/启用确认 */}
      <ConfirmModal
        open={confirmToggleStatus}
        onClose={() => setConfirmToggleStatus(false)}
        onConfirm={() => void handleToggleStatus()}
        loading={saving}
        title={t.customers.modalToggleStatusTitle(selected?.status === "active" ? "disable" : "enable")}
        description={t.customers.modalToggleStatusDesc(selected?.status === "active" ? "disable" : "enable", selected?.email || "")}
        confirmText={selected?.status === "active" ? t.customers.btnDisableCustomer : t.customers.btnEnableCustomer}
        danger={selected?.status === "active"}
      />
    </div>
  );
}
