import { describe, expect, it } from "vitest";
import { buildPaddleWebhookUrl } from "./billing-webhook";

describe("Paddle webhook URL", () => {
  it("uses the instance Admin/API origin and selected Paddle environment", () => {
    expect(buildPaddleWebhookUrl("https://license.example.test", "3Jd9K_aP0qUwbL6F7sTn2Q", "sandbox"))
      .toBe("https://license.example.test/api/v1/webhooks/payments/3Jd9K_aP0qUwbL6F7sTn2Q/paddle/sandbox");
  });

  it("replaces any stored path and removes query or fragment state", () => {
    expect(buildPaddleWebhookUrl("https://license.example.test/old?x=1#hash", "my app", "live"))
      .toBe("https://license.example.test/api/v1/webhooks/payments/my%20app/paddle/live");
  });
});
