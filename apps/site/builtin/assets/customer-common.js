import { el, showError } from "./ui.js";
import { isLoginRequired } from "./api.js";

const messages = {
  "zh-CN": {
    loginUnknown: "申请结果暂时无法确认，请先查看邮箱；未收到邮件时可以重新申请登录链接。", authUnknown: "登录结果暂时无法确认。你可以进入“我的授权”查看是否已登录，或重新申请登录链接。", logoutUnknown: "退出结果暂时无法确认，请刷新页面检查当前登录状态。", canceled: "已取消", past_due: "待付款", paused: "已暂停", trialing: "试用中", loginTitle: "登录我的授权", loginIntro: "使用购买时填写的邮箱，无需设置密码。", email: "购买邮箱", emailPlaceholder: "you@example.com", sendLink: "发送登录链接", sending: "正在发送…", verification: "完成验证后即可发送登录链接。", accepted: "如果这个邮箱有可用的授权，我们会发送登录链接。请查看收件箱和垃圾邮件。", authTitle: "确认登录", authIntro: "点击下方按钮，登录并查看你的授权。", confirmLogin: "确认登录", loggingIn: "正在登录…", invalidLink: "这个登录链接无法使用或已过期，请重新申请。", requestLink: "重新获取登录链接", portalTitle: "我的授权", portalIntro: "查看已购买的产品、使用期限和已激活设备。", loading: "正在加载…", retry: "重新加载", logout: "退出登录", loggingOut: "正在退出…", noLicenses: "这里还没有授权", noLicensesHint: "请确认你使用的是购买时填写的邮箱；刚完成购买时，授权可能需要稍等片刻。", viewPrices: "查看产品与价格", details: "查看授权", back: "返回我的授权", detailTitle: "授权详情", status: "状态", type: "授权类型", expires: "使用期限", updates: "免费更新至", devicesLimit: "可激活设备", features: "包含功能", noExpiry: "长期有效", notApplicable: "不适用", devices: "已激活设备", devicesHint: "释放不再使用的设备后，可以在其他设备上使用授权。", noDevices: "还没有激活设备。", device: "未命名设备", platform: "平台", activatedAt: "激活时间", lastUsed: "最近验证", deactivate: "释放设备", deactivating: "正在释放…", deactivated: "设备已释放。", subscription: "订阅与续费", noSubscription: "这份授权没有由支付平台管理的订阅。", manualSubscription: "这份订阅由产品提供方管理，请联系支持人员处理续费。", periodEnd: "当前周期至", nextBilled: "下次扣款", cancelAtEnd: "本期结束后停止续费", manageSubscription: "管理订阅", opening: "正在打开…", recover: "重新获取注册码", recoverHint: "生成新注册码后，旧码会立即失效，已激活设备会保留。", generate: "生成新注册码", generating: "正在生成…", reset: "安全重置", resetHint: "如果注册码可能泄露，可以同时更换注册码并撤销全部设备激活。设备需要使用新注册码重新激活。", resetAction: "更换注册码并撤销全部设备", resetting: "正在重置…", keyTitle: "新注册码已生成", keyHint: "只在当前页面显示，请复制并妥善保存。", copy: "复制注册码", copied: "已复制", copyFailed: "无法自动复制，请手动选择并复制注册码。", hideKey: "隐藏注册码", deliveryAccepted: "邮件服务商已接收通知邮件；是否送达请查看邮箱。", deliveryPending: "通知邮件正在等待发送，你现在就可以复制新注册码。", deliveryUnavailable: "通知邮件暂未发送成功，你仍可以复制新注册码。", refreshedAuth: "为保护你的授权，请重新通过邮箱登录，然后再次发起操作。", loginRequired: "请先通过邮箱登录，再查看或管理授权。", networkError: "暂时无法连接，请检查网络后再试。", unknownOutcome: "结果暂时无法确认。请先刷新页面查看当前状态，再决定是否继续操作，避免重复生成或重置。", actionFailed: "这次操作未能完成。请查看下方信息，或联系支持人员。", readFailed: "暂时无法加载这部分内容，请稍后重新加载。", turnstileFailed: "验证暂时不可用，请重新加载页面再试。", authConfigFailed: "暂时无法通过邮箱登录，请稍后再试或联系支持人员。", sandbox: "测试授权", active: "可使用", expired: "已到期", suspended: "已暂停", revoked: "已撤销", deactivatedStatus: "已释放", trial: "试用", perpetual: "永久授权", fixed_term: "限期授权", subscriptionType: "订阅授权", none: "无", unknown: "暂无", signInAgain: "重新登录", account: "当前邮箱", working: "正在处理…", regionFailed: "部分信息暂时无法加载，其他内容仍可使用。",
  },
  "en-US": {
    loginUnknown: "The request could not be confirmed. Check your inbox before requesting another sign-in link.", authUnknown: "Sign-in could not be confirmed. Open My licenses to check whether you are signed in, or request a new link.", logoutUnknown: "Sign-out could not be confirmed. Reload to check your current sign-in status.", canceled: "Canceled", past_due: "Payment due", paused: "Paused", trialing: "In trial", loginTitle: "Sign in to your licenses", loginIntro: "Use the email from your purchase. No password needed.", email: "Purchase email", emailPlaceholder: "you@example.com", sendLink: "Send sign-in link", sending: "Sending…", verification: "Complete the check to request a sign-in link.", accepted: "If this email has an available license, we will send a sign-in link. Check your inbox and spam folder.", authTitle: "Confirm sign-in", authIntro: "Use the button below to sign in and view your licenses.", confirmLogin: "Confirm sign-in", loggingIn: "Signing in…", invalidLink: "This sign-in link is unavailable or has expired. Request a new link.", requestLink: "Request a new sign-in link", portalTitle: "My licenses", portalIntro: "View your purchased products, access periods, and activated devices.", loading: "Loading…", retry: "Reload", logout: "Sign out", loggingOut: "Signing out…", noLicenses: "No licenses here yet", noLicensesHint: "Check that you used the email from your purchase. A recent purchase may take a moment to appear.", viewPrices: "View products and prices", details: "View license", back: "Back to my licenses", detailTitle: "License details", status: "Status", type: "License type", expires: "Access until", updates: "Updates until", devicesLimit: "Device allowance", features: "Included features", noExpiry: "No expiry", notApplicable: "Not applicable", devices: "Activated devices", devicesHint: "Release a device you no longer use to use the license on another device.", noDevices: "No devices have been activated yet.", device: "Unnamed device", platform: "Platform", activatedAt: "Activated", lastUsed: "Last verified", deactivate: "Release device", deactivating: "Releasing…", deactivated: "Device released.", subscription: "Subscription and renewal", noSubscription: "This license has no subscription managed by the payment provider.", manualSubscription: "This subscription is managed by the product provider. Contact support for renewal.", periodEnd: "Current period ends", nextBilled: "Next payment", cancelAtEnd: "Renewal stops at the end of this period", manageSubscription: "Manage subscription", opening: "Opening…", recover: "Get a new license key", recoverHint: "A new key replaces the old key immediately. Activated devices stay active.", generate: "Generate a new key", generating: "Generating…", reset: "Security reset", resetHint: "If your key may have been shared, replace it and revoke all device activations. Devices will need to activate again using the new key.", resetAction: "Replace key and revoke all devices", resetting: "Resetting…", keyTitle: "Your new license key is ready", keyHint: "It is only shown on this page. Copy it and keep it safe.", copy: "Copy license key", copied: "Copied", copyFailed: "Automatic copying is unavailable. Select and copy the key manually.", hideKey: "Hide license key", deliveryAccepted: "The email provider accepted the notification. Check your inbox to confirm delivery.", deliveryPending: "The notification is waiting to be sent. You can copy your new key now.", deliveryUnavailable: "The notification has not been sent successfully. You can still copy your new key.", refreshedAuth: "To protect your license, sign in through email again, then start this action again.", loginRequired: "Sign in through email to view or manage your licenses.", networkError: "We could not connect. Check your connection and try again.", unknownOutcome: "The result could not be confirmed. Reload to check the current state before taking another action, to avoid replacing or resetting the key twice.", actionFailed: "This action could not be completed. Check the information below or contact support.", readFailed: "This information could not be loaded. Try reloading it later.", turnstileFailed: "The verification check is unavailable. Reload the page and try again.", authConfigFailed: "Email sign-in is temporarily unavailable. Try again later or contact support.", sandbox: "Test license", active: "Available", expired: "Expired", suspended: "Paused", revoked: "Revoked", deactivatedStatus: "Released", trial: "Trial", perpetual: "Perpetual license", fixed_term: "Fixed-term license", subscriptionType: "Subscription license", none: "None", unknown: "Unavailable", signInAgain: "Sign in again", account: "Signed in as", working: "Working…", regionFailed: "Some information could not be loaded. The other sections are still available.",
  },
};

export function ct(key, locale) {
  const value = messages[locale]?.[key];
  if (typeof value !== "string") throw new Error(`Missing customer translation: ${key}`);
  return value;
}

export function localizeCustomer(locale, root = document) {
  root.querySelectorAll("[data-customer-i18n]").forEach((node) => { node.textContent = ct(node.dataset.customerI18n, locale); });
  root.querySelectorAll("[data-customer-placeholder]").forEach((node) => { node.placeholder = ct(node.dataset.customerPlaceholder, locale); });
}

export function customerError(target, error, locale, { writing = false, unknownMessage = "unknownOutcome" } = {}) {
  const key = error?.code === "CUSTOMER_RECENT_AUTH_REQUIRED" ? "refreshedAuth"
    : isLoginRequired(error) ? "loginRequired"
      : error?.code?.startsWith("TURNSTILE_") ? "authConfigFailed"
        : error?.outcomeUnknown ? unknownMessage
          : error?.code === "CUSTOMER_NETWORK_ERROR" ? "networkError"
            : writing ? "actionFailed" : "readFailed";
  showError(target, error, locale);
  target.querySelector("p").textContent = ct(key, locale);
  if (isLoginRequired(error)) target.append(el("a", { className: "button button-secondary", href: "/customer/login", text: ct("signInAgain", locale) }));
}

export function dateText(value, locale, empty = "unknown") {
  if (!value) return ct(empty, locale);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

export function statusText(value, locale) {
  const keys = { active: "active", expired: "expired", suspended: "suspended", revoked: "revoked", deactivated: "deactivatedStatus", trial: "trial", perpetual: "perpetual", fixed_term: "fixed_term", subscription: "subscriptionType", canceled: "canceled", past_due: "past_due", paused: "paused", trialing: "trialing" };
  return keys[value] ? ct(keys[value], locale) : String(value ?? ct("unknown", locale));
}

export function deliveryText(status, locale) {
  if (status === "accepted") return ct("deliveryAccepted", locale);
  if (["pending", "processing", "retry_scheduled"].includes(status)) return ct("deliveryPending", locale);
  return ct("deliveryUnavailable", locale);
}

export function row(label, value) {
  return el("div", {}, el("dt", { text: label }), el("dd", { text: value }));
}
