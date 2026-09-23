import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { api, type SystemIssue } from "../../lib/api-client";
import { Badge, Button, ErrorPanel, formatDate } from "../../components/ui";

export function InstanceIssueAlert({ onOpenIssues, refreshKey }: { onOpenIssues: () => void; refreshKey: number }) {
  const [issues, setIssues] = useState<SystemIssue[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    void api.admin.system.issues.list().then((result) => {
      if (active) setIssues(result.items.filter((item) => item.status === "pending"));
    }).catch((caught) => { if (active) setError(caught) });
    return () => { active = false };
  }, [refreshKey]);

  if (error) return <ErrorPanel error={error} title="无法加载系统运行告警" />;
  if (issues.length === 0) return null;
  const recent = [...issues].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0]!;
  return (
    <aside className="instance-issue-alert" aria-label="实例待处理问题">
      <AlertTriangle className="size-5" />
      <div><strong>{recent.errorCode}</strong><span>{recent.category} · {recent.operation} · 最近发生于 {formatDate(recent.lastSeenAt)}</span></div>
      <Badge tone="warning">{issues.length} 个待处理</Badge>
      <Button variant="secondary" onClick={onOpenIssues}>查看完整列表 <ArrowRight className="size-4" /></Button>
    </aside>
  );
}
