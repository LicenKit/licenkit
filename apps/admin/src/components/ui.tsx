import { Component, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ErrorInfo, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import { clsx } from "clsx";
import { ApiError, formatApiError } from "../lib/api-client";
import { useI18n, getCurrentLocale, dictionaries, type SupportedLocale } from "../lib/i18n";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[LicenKit Admin] View rendering crashed:", error, errorInfo);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  override render() {
    if (this.state.hasError) {
      const isEn = getCurrentLocale() === "en-US";
      return (
        <div className="card" style={{ margin: "1.5rem 0", padding: "1.5rem" }}>
          <ErrorPanel error={this.state.error} title={this.props.fallbackTitle || (isEn ? "Failed to load view" : "页面加载出现异常")} floating={false} />
          <div style={{ marginTop: "1rem" }}>
            <Button variant="secondary" onClick={this.reset}>
              {isEn ? "Retry" : "重试加载"}
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Button({ className, variant = "primary", loading, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; loading?: boolean }) {
  return (
    <button
      className={clsx("button", `button-${variant}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
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
  const tone = statusTone(status ?? undefined);
  return (
    <Badge tone={tone}>
      <span className={clsx("status-dot", `status-dot-${tone}`)} aria-hidden="true" />
      {label || status || "—"}
    </Badge>
  );
}

export function Modal({ open, title, description, children, onClose, wide = false }: { open: boolean; title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    (focusable?.[0] ?? dialog)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )];
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section ref={dialogRef} tabIndex={-1} className={clsx("modal", wide && "modal-wide")} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <ModalCloseButton onClose={onClose} />
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

function ModalCloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <button className="icon-button" type="button" onClick={onClose} aria-label={t.common.close}>
      <X className="size-5" />
    </button>
  );
}

export interface ErrorPanelProps {
  error: unknown;
  title?: string;
  onClose?: () => void;
  floating?: boolean;
}

export function ErrorPanel({ error, title, onClose, floating = true }: ErrorPanelProps) {
  const { t } = useI18n();
  const [dismissedError, setDismissedError] = useState<unknown>(null);
  const [prevError, setPrevError] = useState<unknown>(error);

  if (prevError !== error) {
    setPrevError(error);
    setDismissedError(null);
  }

  if (!error || error === dismissedError) return null;
  const apiError = error instanceof ApiError ? error : null;
  const panelTitle = title ?? (apiError ? t.common.requestFailed : t.common.unknownError);
  const codedError = error instanceof Error && "code" in error && typeof error.code === "string" ? error : null;
  const details = apiError?.details ?? (codedError && "details" in codedError ? codedError.details : undefined);
  const message = apiError ? formatApiError(apiError) : codedError ? `${codedError.code}: ${codedError.message}` : formatApiError(error);

  const handleClose = () => {
    setDismissedError(error);
    onClose?.();
  };

  const content = (
    <>
      <AlertCircle className="size-5 shrink-0" />
      <div className="min-w-0">
        <strong>{panelTitle}</strong>
        <p>{message}</p>
        {details !== undefined ? (
          <details>
            <summary>{t.common.viewRawError}</summary>
            <pre>{safeJson(details)}</pre>
          </details>
        ) : null}
        {apiError ? <p className="diagnostic-line">HTTP {apiError.status} · {apiError.method} {apiError.path}</p> : null}
      </div>
      <button
        type="button"
        className={floating ? "floating-error-close" : "notice-close"}
        onClick={handleClose}
        aria-label={t.common.close}
      >
        <X className="size-4" />
      </button>
    </>
  );

  if (floating) {
    const portalElement = (
      <div className="floating-error-portal">
        <div className="floating-error-panel" role="alert">
          {content}
        </div>
      </div>
    );
    if (typeof document !== "undefined" && document.body) {
      return createPortal(portalElement, document.body);
    }
    return portalElement;
  }

  return (
    <div className="notice notice-error has-close" role="alert">
      {content}
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "success" | "warning" }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertCircle : Info;
  return <div className={clsx("notice", `notice-${tone}`)} role={tone === "success" ? "status" : undefined} aria-live={tone === "success" ? "polite" : undefined}><Icon className="size-5 shrink-0" /><div>{children}</div></div>;
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();
  return <div className="state-panel" role="status" aria-live="polite"><Loader2 aria-hidden="true" className="size-5 animate-spin" /><span>{label ?? t.common.loading}</span></div>;
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

export function formatDate(value?: string | null, locale?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  const targetLocale = locale || getCurrentLocale();
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(targetLocale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function CopyValue({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  return <Button type="button" variant="secondary" onClick={() => void navigator.clipboard.writeText(value)}>{label ?? t.common.copy}</Button>;
}

export function formatDurationSeconds(seconds?: number | null, locale?: string): string {
  if (seconds === undefined || seconds === null) return "—";
  const targetLocale = (locale || getCurrentLocale()) as SupportedLocale;
  const dict = dictionaries[targetLocale] || dictionaries["zh-CN"];
  const d = dict.common.duration;
  if (seconds === 0) return d.seconds(0);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (days > 0 && hours === 0 && minutes === 0 && remainingSeconds === 0) {
    return d.days(days, seconds);
  }
  if (hours > 0 && days === 0 && minutes === 0 && remainingSeconds === 0) {
    return d.hours(hours, seconds);
  }
  if (minutes > 0 && days === 0 && hours === 0 && remainingSeconds === 0) {
    return d.minutes(minutes, seconds);
  }
  return d.seconds(seconds);
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  confirmText,
  cancelLabel,
  variant,
  danger = false,
  loading = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  confirmText?: string;
  cancelLabel?: string;
  variant?: "primary" | "danger";
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const resolvedVariant = variant ?? (danger ? "danger" : "primary");
  const resolvedCancelLabel = cancelLabel ?? t.common.cancel;
  const resolvedConfirmLabel = confirmText ?? confirmLabel ?? t.common.confirm;
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="form-stack">
        {description ? (
          typeof description === "string" ? (
            <p className="field-hint" style={{ fontSize: "0.85rem", color: "var(--muted)", lineHeight: 1.6 }}>
              {description}
            </p>
          ) : (
            description
          )
        ) : null}
        {children}
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={onClose} disabled={loading}>
            {resolvedCancelLabel}
          </Button>
          <Button variant={resolvedVariant} type="button" loading={loading} onClick={() => void onConfirm()}>
            {resolvedConfirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function Drawer({
  open,
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = drawerRef.current;
    const focusable = drawer?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    (focusable?.[0] ?? drawer)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !drawer) return;
      const items = [...drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )];
      if (items.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <aside ref={drawerRef} tabIndex={-1} className={clsx("drawer", wide && "drawer-wide")} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
        <header className="drawer-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <div id={descriptionId} className="drawer-description">{description}</div> : null}
          </div>
          <DrawerCloseButton onClose={onClose} />
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

function DrawerCloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <button className="icon-button" type="button" onClick={onClose} aria-label={t.common.close}>
      <X className="size-5" />
    </button>
  );
}

export function PaginationBar({
  page,
  totalPages,
  totalItems,
  onPageChange,
  loading = false,
}: {
  page: number;
  totalPages: number;
  totalItems?: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
}) {
  const { t } = useI18n();
  if (totalPages <= 1 && (totalItems === undefined || totalItems <= 0)) return null;

  return (
    <div className="pagination-bar">
      <div className="pagination-info">
        <span>{t.common.pagination.pageInfo(page, Math.max(1, totalPages))}</span>
        {totalItems !== undefined ? <span className="pagination-total">（{t.common.pagination.totalItems(totalItems)}）</span> : null}
      </div>
      <div className="button-row">
        <Button
          variant="secondary"
          disabled={page <= 1 || loading}
          onClick={() => onPageChange(page - 1)}
        >
          {t.common.pagination.prev}
        </Button>
        <Button
          variant="secondary"
          disabled={page >= totalPages || loading}
          onClick={() => onPageChange(page + 1)}
        >
          {t.common.pagination.next}
        </Button>
      </div>
    </div>
  );
}
