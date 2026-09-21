import { describe, expect, it } from "vitest";
import { nextSetupStep, previousSetupStep } from "./setup-flow";

describe("setup flow", () => {
  it("只按 Token、User、Instance 的顺序前进", () => {
    expect(nextSetupStep("token")).toBe("user");
    expect(nextSetupStep("user")).toBe("instance");
    expect(nextSetupStep("instance")).toBe("instance");
  });

  it("返回时不会绕过 Token 验证页", () => {
    expect(previousSetupStep("instance")).toBe("user");
    expect(previousSetupStep("user")).toBe("token");
    expect(previousSetupStep("token")).toBe("token");
  });
});
