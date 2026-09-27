import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, type Instance } from "../../lib/api-client";
import {
  Badge,
  Button,
  Card,
  DefinitionList,
  ErrorPanel,
  LoadingState,
  Notice,
  PageHeader,
  StatusBadge,
} from "../../components/ui";
import { useI18n } from "../../lib/i18n/I18nContext";

export function InstanceView({ initialInstance }: { initialInstance: Instance }) {
  const { t, formatDate } = useI18n();
  const [instance, setInstance] = useState(initialInstance);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setInstance(await api.admin.instance.get());
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.settings.instanceEyebrow}
        title={t.settings.instanceTitle}
        description={t.settings.instanceDescription}
        action={
          <Button variant="secondary" loading={loading} onClick={() => void load()}>
            <RefreshCw className="size-4" />
            {t.common.refresh}
          </Button>
        }
      />
      <ErrorPanel error={error} onClose={() => setError(null)} />
      {loading && !instance.id ? (
        <LoadingState />
      ) : (
        <Card>
          <div className="card-header">
            <div>
              <p className="eyebrow">{t.settings.instanceSectionTitle}</p>
              <h2>{instance.name}</h2>
              <p className="mono">{instance.id}</p>
            </div>
            <StatusBadge status={instance.status} />
          </div>
          <DefinitionList
            items={[
              { label: t.settings.instanceNameLabel, value: instance.name },
              { label: t.settings.instanceIdLabel, value: <code>{instance.id}</code> },
              {
                label: t.settings.adminApiUrlLabel,
                value: (
                  <a href={instance.adminApiUrl} target="_blank" rel="noreferrer">
                    {instance.adminApiUrl}
                  </a>
                ),
              },
              {
                label: t.settings.customerSiteUrlLabel,
                value: (
                  <a href={instance.customerSiteUrl} target="_blank" rel="noreferrer">
                    {instance.customerSiteUrl}
                  </a>
                ),
              },
              {
                label: t.settings.instanceStatusLabel,
                value: (
                  <Badge tone={instance.status === "active" ? "success" : "warning"}>
                    {instance.status === "active"
                      ? `${t.common.statusActive} (active)`
                      : instance.status}
                  </Badge>
                ),
              },
              { label: t.settings.createdAtLabel, value: formatDate(instance.createdAt) },
              { label: t.settings.updatedAtLabel, value: formatDate(instance.updatedAt) },
            ]}
          />
          <Notice tone="info">
            <strong>{t.settings.networkNoticeTitle}</strong>
            <p>{t.settings.networkNoticeBody}</p>
          </Notice>
        </Card>
      )}
    </div>
  );
}
