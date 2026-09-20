import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, Loader2 } from "lucide-react";
import { clsx } from "clsx";
import { ApiError, formatApiError } from "../lib/api-client";

export function Button({ className, variant = "primary", loading, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; loading?: boolean }) {
  return <button className={clsx("button", `button-${variant}`, className)} disabled={disabled || loading} {...props}>
    {loading ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
    {children}
  </button>;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx("card", className)}>{children}</section>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}</label>;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx("input", props.className)} {...props} />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "success" | "warning" | "danger" | "info" | "neutral" }) {
  return <span className={clsx("badge", `badge-${tone}`)}>{children}</span>;
}

function statusTone(status?: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (!status) return "neutral";
  if (["active", "accepted", "completed"].includes(status)) return "success";
  if (["pending", "processing", "past_due"].includes(status)) return "warning";
  if (["failed", "revoked", "disabled", "expired"].includes(status)) return "danger";
  return "info";
}

export function StatusBadge({ status }: { status?: string | null }) {
  return <Badge tone={statusTone(status ?? undefined)}>{status || "—"}</Badge>;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function ErrorPanel({ error, title = "请求失败" }: { error: unknown; title?: string }) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  const codedError = error instanceof Error && "code" in error && typeof error.code === "string" ? error : null;
  const details = apiError?.details ?? (codedError && "details" in codedError ? codedError.details : undefined);
  const message = apiError ? formatApiError(apiError) : codedError ? `${codedError.code}: ${codedError.message}` : formatApiError(error);
  return <div className="notice notice-error" role="alert"><AlertCircle className="size-5 shrink-0" /><div className="min-w-0"><strong>{title}</strong><p>{message}</p>{details !== undefined ? <details><summary>查看原始错误详情</summary><pre>{safeJson(details)}</pre></details> : null}{apiError ? <p className="diagnostic-line">HTTP {apiError.status} · {apiError.method} {apiError.path}</p> : null}</div></div>;
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "success" | "warning" }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertCircle : Info;
  return <div className={clsx("notice", `notice-${tone}`)}><Icon className="size-5 shrink-0" /><div>{children}</div></div>;
}

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return <div className="state-panel"><Loader2 className="size-5 animate-spin" /><span>{label}</span></div>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><h3>{title}</h3><p>{description}</p></div>;
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
