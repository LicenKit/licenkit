import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { api, type SystemIssue } from "../../lib/api-client";
import { Badge, Button, ErrorPanel } from "../../components/ui";
import { useI18n } from "../../lib/i18n/I18nContext";

export function InstanceIssueAlert({ onOpenIssues, refreshKey }: { onOpenIssues: () => void; refreshKey: number }) {
  const { t, formatDate } = useI18n();
  const [issues, setIssues] = useState<SystemIssue[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    void api.admin.system.issues.list({ status: "pending" }).then((result) => {
      if (active) setIssues(result.items);
    }).catch((caught) => { if (active) setError(caught) });
    return () => { active = false };
  }, [refreshKey]);

  if (error) return <ErrorPanel error={error} onClose={() => setError(null)} title={t.operations.alertErrorTitle} />;
  if (issues.length === 0) return null;
  const recent = [...issues].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0]!;
  return (
    <aside className="instance-issue-alert" aria-label={t.operations.alertAriaLabel}>
      <AlertTriangle className="size-5" />
      <div><strong>{recent.errorCode}</strong><span>{recent.category} · {recent.operation} · {t.operations.alertLastSeen(formatDate(recent.lastSeenAt))}</span></div>
      <Badge tone="warning">{t.operations.alertPendingCount(issues.length)}</Badge>
      <Button variant="secondary" onClick={onOpenIssues}>{t.operations.alertViewAll} <ArrowRight className="size-4" /></Button>
    </aside>
  );
}
