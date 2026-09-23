import { useEffect, useRef, useState } from "react";
import { Check, Languages } from "lucide-react";
import { useI18n } from "../lib/i18n/I18nContext";
import type { SupportedLocale } from "../lib/i18n/types";
import { clsx } from "clsx";

interface LanguageSwitcherProps {
  className?: string;
}

export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function handleSelect(nextLocale: SupportedLocale) {
    setLocale(nextLocale);
    setOpen(false);
  }

  return (
    <div className={clsx("language-menu-container", className)} ref={containerRef}>
      <button
        type="button"
        className="icon-button language-trigger-button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t.settings.languageLabel}
        title={t.settings.languageLabel}
      >
        <Languages className="size-5" />
      </button>

      {open ? (
        <div className="language-dropdown-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            className={clsx("language-menu-item", locale === "zh-CN" && "active")}
            onClick={() => handleSelect("zh-CN")}
          >
            <span>简体中文</span>
            {locale === "zh-CN" ? <Check className="size-4 shrink-0 text-brand" /> : null}
          </button>
          <button
            type="button"
            role="menuitem"
            className={clsx("language-menu-item", locale === "en-US" && "active")}
            onClick={() => handleSelect("en-US")}
          >
            <span>English</span>
            {locale === "en-US" ? <Check className="size-4 shrink-0 text-brand" /> : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}
