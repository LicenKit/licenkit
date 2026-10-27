import { describe, expect, it } from "vitest";
import { passwordResetTokenFromFragment } from "./password-reset-fragment";

describe("password reset fragment", () => {
  const token = `prk_${"a".repeat(64)}`;
  it("accepts exactly one correctly formatted recovery link token", () => {
    expect(passwordResetTokenFromFragment(`#token=${token}`)).toBe(token);
    for (const fragment of ["", "#token=", `#token=${token}&token=${token}`, "#token=not-a-reset-link", `#token=ivk_${"a".repeat(64)}`]) {
      expect(passwordResetTokenFromFragment(fragment)).toBeNull();
    }
  });
});
