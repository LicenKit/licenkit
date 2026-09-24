import type { DeliveryStatus, EmailDelivery } from "./api-client";
import { dictionaries, getCurrentLocale, type EmailDictionary, type SupportedLocale } from "./i18n";

function resolveEmailDict(dict?: EmailDictionary): EmailDictionary {
  if (dict) return dict;
  const locale = (typeof window !== "undefined" ? getCurrentLocale() : "zh-CN") as SupportedLocale;
  return dictionaries[locale]?.email ?? dictionaries["zh-CN"].email;
}

export function deliveryStatusExplanation(status: DeliveryStatus, dict?: EmailDictionary): string {
  const d = resolveEmailDict(dict);
  if (status === "accepted") return d.explanationAccepted;
  if (status === "retry_scheduled") return d.explanationRetryScheduled;
  if (status === "waiting_configuration") return d.explanationWaitingConfig;
  if (status === "expired") return d.explanationExpired;
  if (status === "cancelled") return d.explanationCancelled;
  if (status === "failed") return d.explanationFailed;
  if (status === "processing") return d.explanationProcessing;
  return d.explanationPending;
}

export function deliveryStatusLabel(status: DeliveryStatus, dict?: EmailDictionary): string {
  const d = resolveEmailDict(dict);
  if (["pending", "processing", "retry_scheduled"].includes(status)) return d.statusLabelSending;
  if (status === "waiting_configuration") return d.statusLabelWaitingConfig;
  if (status === "failed") return d.statusLabelFailed;
  if (status === "accepted") return d.statusLabelSent;
  if (status === "expired") return d.statusLabelExpired;
  return d.statusLabelCancelled;
}

export function templateDownload(input: { fileName: string; html: string }): {
  fileName: string;
  mimeType: "text/html;charset=utf-8";
  content: string;
} {
  return { fileName: input.fileName, mimeType: "text/html;charset=utf-8", content: input.html };
}

export function deliveryRecipientLabel(
  delivery: Pick<EmailDelivery, "recipientType" | "customerId">,
  dict?: EmailDictionary
): string {
  const d = resolveEmailDict(dict);
  if (delivery.recipientType === "instance_invitation") return d.recipientInvitation;
  return delivery.customerId ?? d.recipientNoCustomer;
}

export function mayDuplicateOnResend(delivery: EmailDelivery): boolean {
  return delivery.lastError?.possible_duplicate_on_resend === true;
}

export function canRetryDelivery(delivery: EmailDelivery): boolean {
  return !["accepted", "expired", "cancelled", "processing"].includes(delivery.status)
    && (!delivery.sendExpiresAt || Date.parse(delivery.sendExpiresAt) > Date.now());
}

export function canCancelDelivery(delivery: EmailDelivery): boolean {
  return ["pending", "retry_scheduled", "waiting_configuration", "failed"].includes(delivery.status);
}
