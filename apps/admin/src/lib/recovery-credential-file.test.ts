import { describe, expect, it } from "vitest";
import { parseRecoveryCredentialFile, recoveryCredentialText } from "./recovery-credential-file";

describe("recovery credential TXT", () => {
  const credential = `rcv_${"a".repeat(64)}`;
  const file = { email: "owner@example.test", adminUrl: "https://license.example.test", credential };
  it("contains the sign-in address and clear instructions and can be imported", () => {
    const text = recoveryCredentialText(file);
    expect(text).toContain("https://license.example.test/admin/");
    expect(text).toContain("仅可使用一次");
    expect(parseRecoveryCredentialFile(text)).toEqual({ email: file.email, credential });
    expect(parseRecoveryCredentialFile(text.replaceAll("\n", "\r\n"))).toEqual({ email: file.email, credential });
  });
  it("rejects ambiguous, oversized, and unrelated text files", () => {
    const text = recoveryCredentialText(file);
    for (const input of ["", "unrelated", text + text, text.replace(credential, "invalid"), text.replace(file.email, "invalid"), "x".repeat(8193)]) {
      expect(parseRecoveryCredentialFile(input)).toBeNull();
    }
  });
});
