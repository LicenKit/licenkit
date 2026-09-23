import type { DeliveryStatus, EmailDelivery } from "./api-client";

export function deliveryStatusExplanation(status: DeliveryStatus): string {
  if (status === "accepted") return "发信服务商已受理发送请求（已出库）。";
  if (status === "retry_scheduled") return "发信服务商允许自动重试，系统将使用最新配置排队重发。";
  if (status === "waiting_configuration") return "当前发信配置或内容不满足发送要求，等待管理员处理。";
  if (status === "expired") return "业务邮件内容已超过保留有效期，停止继续发送。";
  if (status === "cancelled") return "管理员已手动取消发送，敏感内容已安全清除。";
  if (status === "failed") return "发送失败；若前次请求结果未知，人工重试前需确认是否可能导致重复投递。";
  if (status === "processing") return "系统正在向发信服务商提交发送请求。";
  return "邮件已进入发送队列。";
}

export function deliveryStatusLabel(status: DeliveryStatus): string {
  if (["pending", "processing", "retry_scheduled"].includes(status)) return "发送中";
  if (status === "waiting_configuration") return "待处理";
  if (status === "failed") return "发送失败";
  if (status === "accepted") return "已发送";
  if (status === "expired") return "已过期";
  return "已取消";
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
): string {
  if (delivery.recipientType === "instance_invitation") return "实例邀请";
  return delivery.customerId ?? "未关联客户";
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
