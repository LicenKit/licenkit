import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Mail,
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

  async function toggleStatus() {
    if (!selected) return;
    const action = selected.status === "active" ? "禁用" : "启用";
    if (
      !window.confirm(
        `${action}客户“${selected.email}”？${
          selected.status === "active"
            ? "未消费 Magic Link 和现有 Customer Session 会被吊销，但 License 不会自动暂停。"
            : ""
        }`,
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      if (selected.status === "active") await api.admin.customers.disable(selected.id);
      else await api.admin.customers.enable(selected.id);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function revokeSessions() {
    if (!selected || !window.confirm("吊销该客户的全部 Customer Session 和未消费 Magic Link？")) return;
    setSaving(true);
    setError(null);
    try {
      await api.admin.customers.revokeSessions(selected.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="购买者身份"
        title="Customer"
        description="Customer 与管理员 User 是两套独立身份。由支付履约或手动签发自动建立，支持全宽表格与抽屉查看详情。"
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
                  <p className="eyebrow">Customer Overview</p>
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
                  <span>名下 License</span>
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
              <Notice>
                <Mail className="size-4" />
                <strong>邮箱修改边界</strong>
                <p>
                  客户授权中心不提供自助改邮箱。管理员修改邮箱时，服务端会吊销旧 Challenge 与 Session，但不会自动暂停 License。
                </p>
              </Notice>
              {canManage ? (
                <div className="button-row wrap">
                  <Button variant="secondary" onClick={() => setEditOpen(true)}>
                    编辑联系身份
                  </Button>
                  <Button variant="secondary" loading={saving} onClick={() => void revokeSessions()}>
                    <ShieldOff className="size-4" />吊销客户会话
                  </Button>
                  <Button
                    variant={selected.status === "active" ? "danger" : "secondary"}
                    loading={saving}
                    onClick={() => void toggleStatus()}
                  >
                    {selected.status === "active" ? (
                      <ShieldOff className="size-4" />
                    ) : (
                      <UserRoundCheck className="size-4" />
                    )}
                    {selected.status === "active" ? "禁用 Customer" : "启用 Customer"}
                  </Button>
                </div>
              ) : null}
            </Card>

            <Card>
              <div className="card-header">
                <div>
                  <p className="eyebrow">Ownership</p>
                  <h2>名下 License</h2>
                  <p>License 通过稳定 Customer ID 归属，不以邮箱作为主键。</p>
                </div>
                <Badge>{licenses.length}</Badge>
              </div>
              {licensesLoading ? (
                <LoadingState label="正在读取名下 License" />
              ) : licenses.length === 0 ? (
                <EmptyState title="暂无 License" description="该 Customer 当前没有授权记录。" />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>模型与续期</th>
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
                            <span>{license.licenseModel}</span>
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
        title="编辑 Customer 联系身份"
        description="目标邮箱必须在当前 Instance 内唯一；不会自动合并 Customer。"
      >
        <form className="form-stack" onSubmit={save}>
          <Field label="姓名">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="邮箱">
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required
            />
          </Field>
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button type="submit" loading={saving}>
              保存并吊销旧会话
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
