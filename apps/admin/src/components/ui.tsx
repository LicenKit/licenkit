import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { AlertCircle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import { clsx } from "clsx";
import { ApiError, formatApiError } from "../lib/api-client";

export function Button({ className, variant = "primary", loading, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; loading?: boolean }) {
  return (
    <button
      className={clsx("button", `button-${variant}`, className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx("card", className)}>{children}</section>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description: string; action?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-actions">{action}</div> : null}
    </header>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx("input", props.className)} {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={clsx("input", props.className)} {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx("input", "textarea", props.className)} {...props} />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "success" | "warning" | "danger" | "info" | "neutral" }) {
  return <span className={clsx("badge", `badge-${tone}`)}>{children}</span>;
}

export function statusTone(status?: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (!status) return "neutral";
  if (["active", "ready", "accepted", "processed", "completed", "linked"].includes(status)) return "success";
  if (["draft", "pending", "processing", "retry_scheduled", "waiting_configuration", "past_due", "stale", "needs_attention", "open"].includes(status)) return "warning";
  if (["failed", "expired", "cancelled", "revoked", "disabled", "not_ready", "configuration_error", "email_mismatch"].includes(status)) return "danger";
  return "info";
}

export function StatusBadge({ status, label }: { status?: string | null; label?: string }) {
  return <Badge tone={statusTone(status ?? undefined)}>{label || status || "—"}</Badge>;
}

export function Modal({ open, title, description, children, onClose, wide = false }: { open: boolean; title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className={clsx("modal", wide && "modal-wide")} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X className="size-5" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

export function ErrorPanel({ error, title = "请求失败" }: { error: unknown; title?: string }) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  const codedError = error instanceof Error && "code" in error && typeof error.code === "string" ? error : null;
  const details = apiError?.details ?? (codedError && "details" in codedError ? codedError.details : undefined);
  const message = apiError ? formatApiError(apiError) : codedError ? `${codedError.code}: ${codedError.message}` : formatApiError(error);
  return (
    <div className="notice notice-error" role="alert">
      <AlertCircle className="size-5 shrink-0" />
      <div className="min-w-0">
        <strong>{title}</strong>
        <p>{message}</p>
        {details !== undefined ? (
          <details>
            <summary>查看原始错误详情</summary>
            <pre>{safeJson(details)}</pre>
          </details>
        ) : null}
        {apiError ? <p className="diagnostic-line">HTTP {apiError.status} · {apiError.method} {apiError.path}</p> : null}
      </div>
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "success" | "warning" }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertCircle : Info;
  return <div className={clsx("notice", `notice-${tone}`)}><Icon className="size-5 shrink-0" /><div>{children}</div></div>;
}

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return <div className="state-panel"><Loader2 className="size-5 animate-spin" /><span>{label}</span></div>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function DefinitionList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return <dl className="definition-list">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}

export function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function CopyValue({ value, label = "复制" }: { value: string; label?: string }) {
  return <Button type="button" variant="secondary" onClick={() => void navigator.clipboard.writeText(value)}>{label}</Button>;
}
