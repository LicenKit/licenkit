import { describe, expect, it, vi } from "vitest";
import type { AdminSession } from "./api-client";
import { acceptInvitationForExistingUser } from "./invitation-acceptance";

const session: AdminSession = {
  user: { id: "usr_owner", name: "Owner", email: "owner@example.test" },
  instance: { id: "ins_main", name: "Main", slug: "main", customerSiteUrl: "https://site.example.test", adminApiUrl: "https://license.example.test", status: "active" },
  membership: { role: "owner", status: "active" },
};

describe("existing User invitation acceptance", () => {
  it("已登录时只使用当前 Session 明确接受", async () => {
    const acceptCurrentSession = vi.fn().mockResolvedValue(session);
    const acceptExistingUser = vi.fn().mockResolvedValue(session);
    await expect(acceptInvitationForExistingUser({
      api: { acceptCurrentSession, acceptExistingUser },
      token: "invite_token",
      currentSession: session,
      email: "",
      password: "",
    })).resolves.toBe(session);
    expect(acceptCurrentSession).toHaveBeenCalledWith("invite_token");
    expect(acceptExistingUser).not.toHaveBeenCalled();
  });

  it("未登录时把凭据交给邀请接受端点验证", async () => {
    const acceptCurrentSession = vi.fn().mockResolvedValue(session);
    const acceptExistingUser = vi.fn().mockResolvedValue(session);
    await acceptInvitationForExistingUser({
      api: { acceptCurrentSession, acceptExistingUser },
      token: "invite_token",
      currentSession: null,
      email: "member@example.test",
      password: "strong-password",
    });
    expect(acceptExistingUser).toHaveBeenCalledWith({ token: "invite_token", email: "member@example.test", password: "strong-password" });
    expect(acceptCurrentSession).not.toHaveBeenCalled();
  });
});
