import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  RefreshCw,
  Search,
  ShieldOff,
  UserRound,
  UserRoundCheck,
} from "lucide-react";
import { api, type Customer, type License } from "../../lib/api-client";
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
  Select,
  StatusBadge,
  formatDate,
} from "../../components/ui";

export function CustomersView({ canManage }: { canManage: boolean }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [licensesLoading, setLicensesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // 过滤状态
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  // 编辑 Modal
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "" });

  // 确认对话框状态
  const [confirmToggleStatus, setConfirmToggleStatus] = useState(false);
  const [confirmRevokeSessions, setConfirmRevokeSessions] = useState(false);

  const selected = customers.find((customer) => customer.id === selectedId) ?? null;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.admin.customers.list({ limit: 100 });
      setCustomers(result.items);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!selected) {
      setLicenses([]);
      return;
    }
    setForm({ name: selected.name || "", email: selected.email });
    setLicensesLoading(true);
    api.admin.licenses
      .list({ customerId: selected.id, limit: 100 })
      .then((result) => setLicenses(result.items))
      .catch(setError)
      .finally(() => setLicensesLoading(false));
  }, [selectedId, selected?.updatedAt]);

  const filteredCustomers = useMemo(() => {
    return customers.filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchesEmail = c.email.toLowerCase().includes(q);
        const matchesName = c.name?.toLowerCase().includes(q) ?? false;
        const matchesId = c.id.toLowerCase().includes(q);
        if (!matchesEmail && !matchesName && !matchesId) return false;
      }
      return true;
    });
  }, [customers, statusFilter, searchQuery]);

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
      await load();
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
      await load();
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
        eyebrow="客户身份"
        title="客户管理"
        description="管理通过在线购买或手动签发建立的客户档案，支持查看名下授权、更新联系邮箱及会话安全控制。"
        action={
          <Button variant="secondary" onClick={() => void load()} loading={loading}>
            <RefreshCw className="size-4" />刷新
          </Button>
        }
      />
      <ErrorPanel error={error} />

      <Card>
        {/* 顶部过滤栏 */}
        <div className="filter-bar">
          <div className="filter-group">
            <div className="filter-search">
              <Input
                placeholder="按邮箱、姓名或 Customer ID 搜索..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            <Select
              className="filter-select"
              aria-label="按状态过滤"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">全部状态</option>
              <option value="active">active · 正常</option>
              <option value="disabled">disabled · 已禁用</option>
            </Select>
          </div>
          <Badge>{filteredCustomers.length} 位客户</Badge>
        </div>

        {loading && customers.length === 0 ? (
          <LoadingState label="正在加载客户数据" />
        ) : filteredCustomers.length === 0 ? (
          <EmptyState
            title={customers.length === 0 ? "还没有 Customer" : "未找到匹配的客户"}
            description={customers.length === 0 ? "手动签发或支付履约会自动建立客户记录。" : "请尝试更换搜索关键字或清除过滤条件。"}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>客户</th>
                  <th>联系邮箱</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>最近更新</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((customer) => (
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
                        详情
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 详情抽屉 Drawer */}
      <Drawer
        open={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        title={selected?.name || selected?.email || "客户详情"}
        description={selected ? `Customer ID: ${selected.id}` : undefined}
        wide
      >
        {selected ? (
          <div className="detail-stack">
            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">客户概要</p>
                  <h2>{selected.name || selected.email}</h2>
                  <p className="mono">{selected.id}</p>
                </div>
                <StatusBadge status={selected.status} />
              </div>
              <div className="metric-grid compact">
                <div>
                  <span>联系邮箱</span>
                  <strong>{selected.email}</strong>
                </div>
                <div>
                  <span>名下授权数</span>
                  <strong>{licenses.length}</strong>
                </div>
                <div>
                  <span>创建时间</span>
                  <strong>{formatDate(selected.createdAt)}</strong>
                </div>
                <div>
                  <span>最近更新</span>
                  <strong>{formatDate(selected.updatedAt)}</strong>
                </div>
              </div>
              <Notice tone="info">
                <strong>联系邮箱安全说明</strong>
                <p>
                  修改客户主邮箱后，系统将自动失效原邮箱的登录令牌与活动会话；名下已激活的有效授权不受影响。
                </p>
              </Notice>
              {canManage ? (
                <div className="button-row wrap">
                  <Button variant="secondary" onClick={() => setEditOpen(true)}>
                    编辑联系信息
                  </Button>
                  <Button variant="secondary" loading={saving} onClick={() => setConfirmRevokeSessions(true)}>
                    <ShieldOff className="size-4" />吊销活动会话
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
                    {selected.status === "active" ? "禁用客户" : "启用客户"}
                  </Button>
                </div>
              ) : null}
            </Card>

            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">授权归属</p>
                  <h2>名下授权</h2>
                  <p>查看此客户账号拥有的所有软件授权及其有效状态。</p>
                </div>
                <Badge>{licenses.length}</Badge>
              </div>
              {licensesLoading ? (
                <LoadingState label="正在读取名下授权" />
              ) : licenses.length === 0 ? (
                <EmptyState title="暂无授权记录" description="该客户当前名下没有关联的软件授权。" />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>产品</th>
                        <th>授权模型与续期</th>
                        <th>状态</th>
                        <th>到期时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {licenses.map((license) => (
                        <tr key={license.id}>
                          <td>
                            <strong>{license.productName || license.productId}</strong>
                            <small className="mono">{license.id}</small>
                          </td>
                          <td>
                            <span>{license.licenseModel === "subscription" ? "定期订阅" : "永久授权"}</span>
                            <small>{license.renewalMode}</small>
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
          <LoadingState label="正在加载客户详情" />
        )}
      </Drawer>

      {/* 编辑客户身份 Modal */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="编辑客户联系信息"
        description="修改客户的姓名与主要联系邮箱。邮箱在系统内需保持唯一。"
      >
        <form className="form-stack" onSubmit={save}>
          <Field label="客户姓名">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="例如：张三 / Acme Inc."
            />
          </Field>
          <Field label="联系邮箱">
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
              取消
            </Button>
            <Button type="submit" loading={saving}>
              保存修改
            </Button>
          </div>
        </form>
      </Modal>

      {/* 吊销会话确认 */}
      <ConfirmModal
        open={confirmRevokeSessions}
        onClose={() => setConfirmRevokeSessions(false)}
        onConfirm={() => void handleRevokeSessions()}
        loading={saving}
        title="吊销客户活动会话"
        description={`确定吊销客户“${selected?.email || ""}”当前的所有有效登录会话与未使用的登录链接？客户下次需重新通过邮箱验证登录。`}
        confirmText="确认吊销会话"
        danger
      />

      {/* 禁用/启用确认 */}
      <ConfirmModal
        open={confirmToggleStatus}
        onClose={() => setConfirmToggleStatus(false)}
        onConfirm={() => void handleToggleStatus()}
        loading={saving}
        title={selected?.status === "active" ? "禁用客户账号" : "启用客户账号"}
        description={
          selected?.status === "active"
            ? `确定禁用客户“${selected?.email || ""}”？禁用后客户将无法登录自助门户，现存活动会话将失效。已签发授权本身不会自动暂停。`
            : `确定重新启用客户“${selected?.email || ""}”？启用后客户可重新接收登录凭证并访问门户。`
        }
        confirmText={selected?.status === "active" ? "确认禁用" : "确认启用"}
        danger={selected?.status === "active"}
      />
    </div>
  );
}
