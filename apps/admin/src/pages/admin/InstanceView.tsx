import { useEffect, useState } from "react";
import { Building2, RefreshCw } from "lucide-react";
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
      <PageHeader eyebrow="租户边界" title="Instance" description="当前自部署只开放一个授权业务空间。本页展示 Instance 身份与 Customer Site 地址，不提供状态修改。" action={<Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button>} />
      <ErrorPanel error={error} />
      {loading && !instance.id ? <LoadingState /> : (
        <Card>
          <div className="card-header"><div><p className="eyebrow">Current Instance</p><h2>{instance.name}</h2><p className="mono">{instance.id}</p></div><StatusBadge status={instance.status} /></div>
          <DefinitionList items={[
            { label: "实例名称", value: instance.name },
            { label: "实例标识", value: <code>{instance.slug}</code> },
            { label: "Site URL", value: <a href={instance.siteUrl} target="_blank" rel="noreferrer">{instance.siteUrl}</a> },
            { label: "状态", value: <Badge tone={instance.status === "active" ? "success" : "warning"}>{instance.status}</Badge> },
            { label: "创建时间", value: formatDate(instance.createdAt) },
            { label: "更新时间", value: formatDate(instance.updatedAt) },
          ]} />
          <Notice><Building2 className="size-4" /><strong>Instance 状态只读</strong><p>当前自部署没有暂停或归档 Instance 的操作入口。</p></Notice>
        </Card>
      )}
    </div>
  );
}
