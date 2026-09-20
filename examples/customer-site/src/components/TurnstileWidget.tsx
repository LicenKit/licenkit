import { useEffect, useRef } from "react";

const TURNSTILE_SCRIPT_ID = "licenkit-turnstile-script";
const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(container: HTMLElement, options: {
    sitekey: string;
    action: "customer_magic_link";
    theme: "dark";
    appearance: "always";
    callback(token: string): void;
    "expired-callback"(): void;
    "error-callback"(code?: string): void;
  }): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

let loadingScript: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loadingScript) return loadingScript;
  loadingScript = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    const loaded = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile API did not initialize."));
    const failed = () => reject(new Error("Turnstile official resource could not be loaded."));
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  }).catch((error) => {
    loadingScript = null;
    throw error;
  });
  return loadingScript;
}

export function TurnstileWidget({ siteKey, onToken, onError }: {
  siteKey: string;
  onToken: (token: string | null) => void;
  onError: (error: Error) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let widgetId: string | null = null;
    void loadTurnstile().then((turnstile) => {
      if (!active || !containerRef.current) return;
      widgetId = turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action: "customer_magic_link",
        theme: "dark",
        appearance: "always",
        callback: (token) => { if (active) onToken(token); },
        "expired-callback": () => { if (active) onToken(null); },
        "error-callback": (code) => {
          if (!active) return;
          onToken(null);
          onError(new Error(code ? `Turnstile challenge failed (${code}).` : "Turnstile challenge failed."));
        },
      });
    }).catch((error: unknown) => {
      if (active) onError(error instanceof Error ? error : new Error("Turnstile could not initialize."));
    });
    return () => {
      active = false;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey, onError, onToken]);

  return <div className="turnstile-widget" ref={containerRef} aria-label="Cloudflare Turnstile 人机验证" />;
}
