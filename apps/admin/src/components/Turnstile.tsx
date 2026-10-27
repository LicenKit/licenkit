import { useEffect, useRef } from "react";

interface TurnstileApi {
  ready(callback: () => void): void;
  render(container: HTMLElement, options: {
    sitekey: string; action: string; callback: (token: string) => void;
    "expired-callback": () => void; "error-callback": () => void;
  }): string;
  remove(id: string): void;
}

let scriptPromise: Promise<TurnstileApi> | undefined;
function loadTurnstile(): Promise<TurnstileApi> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => {
      const api = (window as Window & { turnstile?: TurnstileApi }).turnstile;
      if (!api) { script.remove(); reject(new Error("TURNSTILE_LOAD_FAILED")); return }
      api.ready(() => resolve(api));
    };
    script.onerror = () => { script.remove(); reject(new Error("TURNSTILE_LOAD_FAILED")) };
    document.head.appendChild(script);
  }).catch((error) => { scriptPromise = undefined; throw error });
  return scriptPromise;
}

export function Turnstile({ siteKey, action, onToken, onError }: {
  siteKey: string; action: string; onToken: (token: string) => void; onError: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    let widget: string | undefined;
    let api: TurnstileApi | undefined;
    void loadTurnstile().then((loaded) => {
      if (!active || !container.current) return;
      api = loaded;
      widget = loaded.render(container.current, {
        sitekey: siteKey, action,
        callback: (token) => { if (active) onToken(token) },
        "expired-callback": () => { if (active) onToken("") },
        "error-callback": () => { if (active) { onToken(""); onError() } },
      });
    }).catch(() => { if (active) onError() });
    return () => { active = false; if (widget !== undefined) api?.remove(widget) };
  }, [siteKey, action, onToken, onError]);
  return <div ref={container} />;
}
