import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  detectSystemLocale,
  getErrorMessage,
  getStoredPreference,
  resolveActiveLocale,
  setGlobalLocale,
  setStoredPreference,
  zhCN,
  enUS,
  LOCALE_STORAGE_KEY,
} from "./index";
import { formatDate } from "../../components/ui";

class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) {
    return this.store[key] ?? null;
  }
  setItem(key: string, val: string) {
    this.store[key] = String(val);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
}

describe("i18n module", () => {
  let storageMock: LocalStorageMock;

  beforeEach(() => {
    storageMock = new LocalStorageMock();
    vi.stubGlobal("localStorage", storageMock);
    vi.stubGlobal("window", {
      localStorage: storageMock,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    setGlobalLocale("zh-CN");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setGlobalLocale("zh-CN");
  });

  describe("detectSystemLocale", () => {
    it("detects Simplified Chinese from zh-CN and generic zh", () => {
      expect(detectSystemLocale({ languages: ["zh-CN", "en"] })).toBe("zh-CN");
      expect(detectSystemLocale({ languages: ["zh"] })).toBe("zh-CN");
      expect(detectSystemLocale({ languages: ["zh-TW", "en-US"] })).toBe("zh-CN");
      expect(detectSystemLocale({ language: "zh-HK" })).toBe("zh-CN");
    });

    it("detects English from en, en-US, en-GB", () => {
      expect(detectSystemLocale({ languages: ["en-US", "zh-CN"] })).toBe("en-US");
      expect(detectSystemLocale({ languages: ["en-GB"] })).toBe("en-US");
      expect(detectSystemLocale({ language: "en" })).toBe("en-US");
    });

    it("falls back to en-US for unsupported or unknown languages", () => {
      expect(detectSystemLocale({ languages: ["ja-JP", "fr-FR"] })).toBe("en-US");
      expect(detectSystemLocale({ languages: [] })).toBe("en-US");
      expect(detectSystemLocale({})).toBe("en-US");
    });
  });

  describe("resolveActiveLocale", () => {
    it("respects explicitly stored locale", () => {
      setStoredPreference("zh-CN");
      expect(resolveActiveLocale({ languages: ["en-US"] })).toBe("zh-CN");

      setStoredPreference("en-US");
      expect(resolveActiveLocale({ languages: ["zh-CN"] })).toBe("en-US");
    });

    it("delegates to system detection when no locale has been stored", () => {
      storageMock.clear();
      expect(resolveActiveLocale({ languages: ["zh-CN"] })).toBe("zh-CN");
      expect(resolveActiveLocale({ languages: ["en-US"] })).toBe("en-US");
      expect(resolveActiveLocale({ languages: ["es-ES"] })).toBe("en-US");
    });
  });

  describe("locale persistence", () => {
    it("stores and retrieves locale correctly", () => {
      expect(getStoredPreference()).toBeNull();

      setStoredPreference("en-US");
      expect(storageMock.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
      expect(getStoredPreference()).toBe("en-US");

      setStoredPreference("zh-CN");
      expect(storageMock.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
      expect(getStoredPreference()).toBe("zh-CN");
    });
  });

  describe("dictionary completeness and symmetry (Fail-Fast)", () => {
    it("has identical keys across zh-CN and en-US dictionaries", () => {
      const zhKeys = Object.keys(zhCN).sort();
      const enKeys = Object.keys(enUS).sort();
      expect(zhKeys).toEqual(enKeys);

      const namespaces: Array<keyof typeof zhCN> = [
        "common",
        "setup",
        "nav",
        "topbar",
        "settings",
        "auth",
        "invitationAccept",
        "overview",
        "products",
        "licensePlans",
        "licenses",
        "customers",
        "billing",
        "email",
        "operations",
        "members",
      ];

      for (const ns of namespaces) {
        const zhNsKeys = Object.keys(zhCN[ns]).sort();
        const enNsKeys = Object.keys(enUS[ns]).sort();
        expect(enNsKeys, `Namespace ${ns} keys mismatch`).toEqual(zhNsKeys);
      }
    });

    it("has 100% error code parity across both languages", () => {
      const zhErrors = Object.keys(zhCN.errors).sort();
      const enErrors = Object.keys(enUS.errors).sort();

      expect(zhErrors.length).toBeGreaterThanOrEqual(50);
      expect(enErrors).toEqual(zhErrors);

      // Verify no empty translations
      for (const code of zhErrors) {
        expect(zhCN.errors[code]?.length).toBeGreaterThan(0);
        expect(enUS.errors[code]?.length).toBeGreaterThan(0);
      }
    });

    it("formats setup eyebrow dynamically", () => {
      expect(zhCN.setup.eyebrow(1, 3)).toBe("一次性初始化 · 1 / 3");
      expect(enUS.setup.eyebrow(1, 3)).toBe("One-time Setup · Step 1 of 3");
    });
  });

  describe("getErrorMessage and global locale switching", () => {
    it("returns Chinese error messages when locale is zh-CN", () => {
      setGlobalLocale("zh-CN");
      expect(getErrorMessage("SETUP_TOKEN_INVALID")).toContain("初始化密钥无效");
      expect(getErrorMessage("UNAUTHORIZED")).toBe("登录状态已失效，请重新登录");
    });

    it("returns English error messages when locale is en-US", () => {
      setGlobalLocale("en-US");
      expect(getErrorMessage("SETUP_TOKEN_INVALID")).toContain("Invalid setup token");
      expect(getErrorMessage("UNAUTHORIZED")).toBe("Session expired. Please sign in again.");
    });

    it("falls back gracefully for unknown error code", () => {
      setGlobalLocale("en-US");
      expect(getErrorMessage("UNKNOWN_CUSTOM_CODE", "Custom Fallback")).toBe("Custom Fallback");
      expect(getErrorMessage("ANOTHER_UNKNOWN")).toBe("ANOTHER_UNKNOWN");
    });
  });

  describe("formatDate integration with locale", () => {
    it("formats date according to active locale", () => {
      const sampleDate = "2026-09-23T08:00:00.000Z";

      setGlobalLocale("zh-CN");
      const zhFormatted = formatDate(sampleDate);
      expect(zhFormatted).toBeTruthy();
      expect(zhFormatted).not.toBe("—");

      setGlobalLocale("en-US");
      const enFormatted = formatDate(sampleDate);
      expect(enFormatted).toBeTruthy();
      expect(enFormatted).not.toBe("—");
    });
  });
});
