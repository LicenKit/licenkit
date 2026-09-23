import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  dictionaries,
  getStoredLocale,
  resolveActiveLocale,
  setGlobalLocale,
  setStoredLocale,
  type LocaleDictionary,
  type SupportedLocale,
} from "./index";

export interface I18nContextValue {
  locale: SupportedLocale;
  preference: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  setPreference: (locale: SupportedLocale) => void;
  t: LocaleDictionary;
  formatDate: (value?: string | number | Date | null, options?: Intl.DateTimeFormatOptions) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    const resolved = resolveActiveLocale();
    setGlobalLocale(resolved);
    return resolved;
  });

  const setLocale = useCallback((nextLocale: SupportedLocale) => {
    setLocaleState(nextLocale);
    setStoredLocale(nextLocale);
    setGlobalLocale(nextLocale);
  }, []);

  useEffect(() => {
    // Only listen to languagechange if user has not explicitly stored a preference
    if (getStoredLocale()) return;

    function handleLanguageChange() {
      if (!getStoredLocale()) {
        const resolved = resolveActiveLocale();
        setLocaleState(resolved);
        setGlobalLocale(resolved);
      }
    }

    window.addEventListener("languagechange", handleLanguageChange);
    return () => window.removeEventListener("languagechange", handleLanguageChange);
  }, []);

  const dictionary = useMemo(() => dictionaries[locale] || dictionaries["zh-CN"], [locale]);

  const formatDate = useCallback(
    (value?: string | number | Date | null, options?: Intl.DateTimeFormatOptions): string => {
      if (!value) return "—";
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat(
        locale,
        options || { dateStyle: "medium", timeStyle: "short" }
      ).format(date);
    },
    [locale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      preference: locale,
      setLocale,
      setPreference: setLocale,
      t: dictionary,
      formatDate,
    }),
    [locale, setLocale, dictionary, formatDate]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}
