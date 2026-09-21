import { describe, expect, it, vi } from "vitest";
import { invitationTokenFromFragment, readAndClearInvitationToken, urlWithoutFragment } from "./invitation-fragment";

describe("invitation fragment", () => {
  it("只接受唯一且非空的 token", () => {
    expect(invitationTokenFromFragment("#token=invite_abc-123")).toBe("invite_abc-123");
    expect(invitationTokenFromFragment("#token=")).toBeNull();
    expect(invitationTokenFromFragment("#token=one&token=two")).toBeNull();
    expect(invitationTokenFromFragment("#other=value")).toBeNull();
  });

  it("清理 fragment 时保留 pathname 和 query", () => {
    expect(urlWithoutFragment({ pathname: "/admin/invitations/accept", search: "?source=email" } as Location)).toBe("/admin/invitations/accept?source=email");
    const replaceState = vi.fn();
    const token = readAndClearInvitationToken(
      { pathname: "/admin/invitations/accept", search: "", hash: "#token=secret" } as Location,
      { state: { preserved: true }, replaceState } as unknown as History,
    );
    expect(token).toBe("secret");
    expect(replaceState).toHaveBeenCalledWith({ preserved: true }, "", "/admin/invitations/accept");
  });
});
