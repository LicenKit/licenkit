import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, type Instance } from "../../lib/api-client";
import { Badge, Button, Card, DefinitionList, ErrorPanel, LoadingState, Notice, PageHeader, StatusBadge, formatDate } from "../../components/ui";

export function InstanceView({ initialInstance }: { initialInstance: Instance }) {
  const [instance, setInstance] = useState(initialInstance);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try { setInstance(await api.admin.instance.get()) } catch (caught) { setError(caught) } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, []);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="系统与空间"
        title="空间信息"
        description="当前自托管实例的基础运行信息，以及 LicenKit 与用户官网的公开地址。"
        action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>}
      />
      <ErrorPanel error={error} />
      {loading && !instance.id ? <LoadingState /> : (
        <Card>
          <div className="card-header">
            <div>
              <p className="eyebrow">运行实例</p>
              <h2>{instance.name}</h2>
              <p className="mono">{instance.id}</p>
            </div>
            <StatusBadge status={instance.status} />
          </div>
          <DefinitionList items={[
            { label: "实例名称", value: instance.name },
            { label: "实例标识 (Slug)", value: <code>{instance.slug}</code> },
            { label: "LicenKit Admin/API 地址", value: <a href={instance.adminApiUrl} target="_blank" rel="noreferrer">{instance.adminApiUrl}</a> },
            { label: "Customer Site 地址", value: <a href={instance.customerSiteUrl} target="_blank" rel="noreferrer">{instance.customerSiteUrl}</a> },
            { label: "运行状态", value: <Badge tone={instance.status === "active" ? "success" : "warning"}>{instance.status === "active" ? "正常运行 (active)" : instance.status}</Badge> },
            { label: "创建时间", value: formatDate(instance.createdAt) },
            { label: "最近更新", value: formatDate(instance.updatedAt) },
          ]} />
          <Notice tone="info">
            <strong>实例基础配置说明</strong>
            <p>自部署模式下，请先把 LicenKit Admin/API 域名绑定到当前 Worker；Customer Site 由使用方独立部署。本页不提供 CNAME 或托管证书配置。</p>
          </Notice>
        </Card>
      )}
    </div>
  );
}
