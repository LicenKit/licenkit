import { zhCN } from "./zh-CN";
import { enUS } from "./en-US";
import type { LocaleDictionary, LocalePreference, SupportedLocale } from "./types";

export * from "./types";
export { zhCN } from "./zh-CN";
export { enUS } from "./en-US";

export const LOCALE_STORAGE_KEY = "licenkit_admin_locale_preference";

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ["zh-CN", "en-US"] as const;

export const dictionaries: Record<SupportedLocale, LocaleDictionary> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export function detectSystemLocale(nav?: { languages?: readonly string[]; language?: string }): SupportedLocale {
  const navigatorInstance = nav || (typeof navigator !== "undefined" ? navigator : undefined);
  if (!navigatorInstance) return "zh-CN";

  const candidates: string[] = [];
  if (Array.isArray(navigatorInstance.languages)) {
    candidates.push(...navigatorInstance.languages);
  }
  if (navigatorInstance.language) {
    candidates.push(navigatorInstance.language);
  }

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (normalized.startsWith("zh")) {
      return "zh-CN";
    }
    if (normalized.startsWith("en")) {
      return "en-US";
    }
  }

  return "en-US";
}

export function getStoredLocale(): SupportedLocale | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === "zh-CN" || raw === "en-US") {
      return raw;
    }
  } catch {
    // Fail-soft on localStorage access failures (e.g. cross-origin iframe security restrictions)
  }
  return null;
}

export function setStoredLocale(locale: SupportedLocale): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Fail-soft on storage write limitations
  }
}

export function resolveActiveLocale(
  nav?: { languages?: readonly string[]; language?: string }
): SupportedLocale {
  const stored = getStoredLocale();
  if (stored) {
    return stored;
  }
  return detectSystemLocale(nav);
}

export const getStoredPreference = getStoredLocale;
export const setStoredPreference = setStoredLocale;


let activeGlobalLocale: SupportedLocale = typeof window !== "undefined"
  ? resolveActiveLocale()
  : "zh-CN";

export function setGlobalLocale(locale: SupportedLocale): void {
  activeGlobalLocale = locale;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = locale;
  }
}

export function getCurrentLocale(): SupportedLocale {
  return activeGlobalLocale;
}

export function getDictionary(locale: SupportedLocale = activeGlobalLocale): LocaleDictionary {
  return dictionaries[locale] || dictionaries["zh-CN"];
}

export function getErrorMessage(code: string, fallback?: string): string {
  const dictionary = dictionaries[activeGlobalLocale]?.errors;
  if (dictionary && code in dictionary && dictionary[code]) {
    return dictionary[code];
  }
  const fallbackDictionary = dictionaries["zh-CN"]?.errors;
  if (fallbackDictionary && code in fallbackDictionary && fallbackDictionary[code]) {
    return fallbackDictionary[code];
  }
  return fallback || code;
}
