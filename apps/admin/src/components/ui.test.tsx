import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ApiError } from "../lib/api-client";
import { ErrorPanel, Select } from "./ui";

describe("UI components: Select and ErrorPanel", () => {
  it("Select component renders with input class and options", () => {
    const html = renderToString(
      createElement(Select, { value: "admin", onChange: () => {} },
        createElement("option", { value: "admin" }, "Admin"),
        createElement("option", { value: "member" }, "Member"),
      ),
    );
    expect(html).toContain('class="input"');
    expect(html).toContain('value="admin"');
    expect(html).toContain("Admin");
  });

  it("ErrorPanel returns null when error is absent", () => {
    const html = renderToString(createElement(ErrorPanel, { error: null }));
    expect(html).toBe("");
  });

  it("ErrorPanel renders inline error panel when floating is false", () => {
    const error = new ApiError({
      code: "LAST_ACTIVE_OWNER_REQUIRED",
      message: "不允许移除最后一个处于活动状态的所有者",
      status: 400,
      method: "PATCH",
      path: "/api/admin/members/1",
      requestId: "req_1",
    });
    const html = renderToString(createElement(ErrorPanel, { error, floating: false, onClose: vi.fn() }));
    expect(html).toContain("notice notice-error");
    expect(html).toContain("LAST_ACTIVE_OWNER_REQUIRED");
    expect(html).toContain("notice-close");
    expect(html).toContain("400");
    expect(html).toContain("PATCH");
    expect(html).toContain("/api/admin/members/1");
  });

  it("ErrorPanel renders floating portal markup when floating is true in SSR", () => {
    const error = new Error("Something went wrong");
    const html = renderToString(createElement(ErrorPanel, { error, floating: true, onClose: vi.fn() }));
    expect(html).toContain("floating-error-portal");
    expect(html).toContain("floating-error-panel");
    expect(html).toContain("floating-error-close");
    expect(html).toContain("Something went wrong");
  });
});
