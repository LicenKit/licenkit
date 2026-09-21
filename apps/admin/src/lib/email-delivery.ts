import type { DeliveryStatus, EmailDelivery } from "./api-client";

export function deliveryStatusExplanation(status: DeliveryStatus): string {
  if (status === "accepted") return "邮件服务已接受发送请求；按当前一期定义为已发送，不追踪后续最终投递状态。";
  if (status === "retry_scheduled") return "邮件服务明确允许重试，系统会使用最新配置继续发送。";
  if (status === "waiting_configuration") return "当前邮件配置或内容不满足发送要求，等待管理员处理。";
  if (status === "expired") return "业务内容已经到期清除，不能继续发送。";
  if (status === "cancelled") return "管理员已取消发送，敏感内容已经清除。";
  if (status === "failed") return "发送失败；如果上次请求结果未知，人工重发前必须确认可能产生重复邮件。";
  if (status === "processing") return "系统正在向邮件服务提交发送请求。";
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
