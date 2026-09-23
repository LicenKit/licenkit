import { describe, expect, it } from "vitest";
import type { EmailDelivery } from "./api-client";
import {
  canRetryDelivery,
  deliveryRecipientLabel,
  deliveryStatusExplanation,
  mayDuplicateOnResend,
  templateDownload,
} from "./email-delivery";

function delivery(overrides: Partial<EmailDelivery> = {}): EmailDelivery {
  return {
    id: "edv_test",
    recipientType: "customer",
    customerId: "cus_test",
    notificationType: "license.issue",
    contractVersion: 1,
    recipientEmail: "customer@example.com",
    sendExpiresAt: null,
    variablesExpiresAt: null,
    status: "failed",
    attemptCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("email delivery presentation", () => {
  it("presents Provider acceptance as the phase-one sent boundary", () => {
    expect(deliveryStatusExplanation("accepted")).toContain("发信服务商已受理发送请求");
  });

  it("explains configuration waiting and unknown outcomes", () => {
    expect(deliveryStatusExplanation("waiting_configuration")).toContain("配置");
    expect(mayDuplicateOnResend(delivery({ lastError: { possible_duplicate_on_resend: true } }))).toBe(true);
    expect(mayDuplicateOnResend(delivery())).toBe(false);
  });

  it("only offers retry while business content remains sendable", () => {
    expect(canRetryDelivery(delivery())).toBe(true);
    expect(canRetryDelivery(delivery({ status: "accepted" }))).toBe(false);
    expect(canRetryDelivery(delivery({ sendExpiresAt: "2020-01-01T00:00:00.000Z" }))).toBe(false);
  });

  it("distinguishes customer and Instance Invitation recipients", () => {
    expect(deliveryRecipientLabel(delivery())).toBe("cus_test");
    expect(deliveryRecipientLabel(delivery({ recipientType: "instance_invitation", customerId: null }))).toBe("实例邀请");
  });

  it("preserves the API supplied template filename and source", () => {
    expect(templateDownload({ fileName: "provider-template.html", html: "<p>{{{name}}}</p>" })).toEqual({
      fileName: "provider-template.html",
      mimeType: "text/html;charset=utf-8",
      content: "<p>{{{name}}}</p>",
    });
  });
});
