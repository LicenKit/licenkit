import { LicenKitCheckoutError, type LicenKitCheckoutEvent, type LocalizedPrice } from "./types";

export interface PaddleRuntime {
  Environment?: { set(value: "sandbox"): void };
  Setup(options: { token: string; eventCallback(event: unknown): void }): void;
  PricePreview(options: { items: Array<{ priceId: string; quantity: 1 }> }): Promise<unknown>;
  Checkout: { open(options: Record<string, unknown>): void };
}

declare global {
  interface Window { Paddle?: PaddleRuntime }
}

const listeners = new Set<(event: LicenKitCheckoutEvent) => void>();
let initializedKey: string | null = null;
let loadPromise: Promise<PaddleRuntime> | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function firstString(records: Array<Record<string, unknown> | null>, names: string[]): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const name of names) {
      const value = record[name];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

export function paddleProviderErrorDetails(
  error: unknown,
  environment: "sandbox" | "live",
): Record<string, unknown> {
  const root = asRecord(error);
  const nestedError = asRecord(root?.error);
  const data = asRecord(root?.data);
  const response = asRecord(root?.response);
  const responseData = asRecord(response?.data);
  const records = [root, nestedError, data, responseData];
  const providerCode = firstString(records, ["code", "errorCode", "error_code"]);
  const providerRequestId = firstString(records, ["requestId", "request_id", "request-id"]);
  const message = error instanceof Error
    ? error.message
    : firstString(records, ["message", "detail"]);

  return {
    environment,
    ...(providerCode ? { providerCode: providerCode.slice(0, 200) } : {}),
    ...(providerRequestId ? { providerRequestId: providerRequestId.slice(0, 200) } : {}),
    ...(message ? { providerMessage: message.slice(0, 500) } : {}),
  };
}

function safeProviderEvent(value: unknown): LicenKitCheckoutEvent | null {
  if (value === null || typeof value !== "object") return null;
  const event = value as Record<string, any>;
  if (event.name === "checkout.loaded") return { type: "checkout.loaded" };
  if (event.name === "checkout.closed") return { type: "checkout.closed" };
  if (event.name === "checkout.completed") {
    const id = typeof event.data?.transaction_id === "string" ? event.data.transaction_id : undefined;
    return { type: "checkout.completed", ...(id ? { transactionId: id } : {}) };
  }
  if (event.name === "checkout.error" || event.name === "checkout.payment.error") {
    const code = typeof event.error?.code === "string" ? event.error.code : "PADDLE_CHECKOUT_ERROR";
    return { type: "checkout.error", code };
  }
  return null;
}

async function loadOfficialPaddleJs(): Promise<PaddleRuntime> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new LicenKitCheckoutError("PADDLE_INITIALIZATION_FAILED", "Paddle.js requires a browser environment.");
  }
  if (window.Paddle) return window.Paddle;
  if (!loadPromise) {
    loadPromise = new Promise<PaddleRuntime>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
      script.async = true;
      script.onload = () => window.Paddle
        ? resolve(window.Paddle)
        : reject(new Error("Paddle global was not created."));
      script.onerror = () => reject(new Error("Official Paddle.js failed to load."));
      document.head.appendChild(script);
    });
  }
  try { return await loadPromise; }
  catch (error) {
    loadPromise = null;
    throw new LicenKitCheckoutError("PADDLE_INITIALIZATION_FAILED", "Official Paddle.js failed to load.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function initializePaddle(
  environment: "sandbox" | "live",
  token: string,
  listener: (event: LicenKitCheckoutEvent) => void,
): Promise<PaddleRuntime> {
  listeners.add(listener);
  const paddle = await loadOfficialPaddleJs();
  const key = `${environment}:${token}`;
  if (initializedKey && initializedKey !== key) {
    throw new LicenKitCheckoutError(
      "PADDLE_INITIALIZATION_FAILED",
      "Paddle.js is already initialized for another environment or client-side token.",
      { environment },
    );
  }
  if (!initializedKey) {
    if (environment === "sandbox") paddle.Environment?.set("sandbox");
    try {
      paddle.Setup({
        token,
        eventCallback(raw) {
          const event = safeProviderEvent(raw);
          if (event) listeners.forEach((callback) => callback(event));
        },
      });
      initializedKey = key;
    } catch (error) {
      const details = paddleProviderErrorDetails(error, environment);
      const message = typeof details.providerMessage === "string" ? details.providerMessage : "";
      const originError = /origin|domain|default payment link|website/i.test(message);
      throw new LicenKitCheckoutError(
        originError ? "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE" : "PADDLE_INITIALIZATION_FAILED",
        "Paddle.js initialization failed.",
        details,
      );
    }
  }
  return paddle;
}

export function removePaddleListener(listener: (event: LicenKitCheckoutEvent) => void): void {
  listeners.delete(listener);
}

function field(object: Record<string, any>, camel: string, snake: string): unknown {
  return object[camel] ?? object[snake];
}

export function parsePricePreview(offerId: string, value: unknown): LocalizedPrice {
  const root = value && typeof value === "object" ? value as Record<string, any> : {};
  const data = root.data && typeof root.data === "object" ? root.data : root;
  const details = data.details && typeof data.details === "object" ? data.details : {};
  const totals = details.totals && typeof details.totals === "object" ? details.totals : {};
  const formatted = (details.formattedTotals ?? details.formatted_totals) as Record<string, any> | undefined ?? {};
  const currencyCode = field(data, "currencyCode", "currency_code");
  const subtotal = field(totals, "subtotal", "subtotal");
  const tax = field(totals, "tax", "tax");
  const total = field(totals, "total", "total");
  const formattedSubtotal = field(formatted, "subtotal", "subtotal");
  const formattedTax = field(formatted, "tax", "tax");
  const formattedTotal = field(formatted, "total", "total");
  if (![currencyCode, subtotal, tax, total, formattedSubtotal, formattedTax, formattedTotal].every((item) => typeof item === "string")) {
    throw new LicenKitCheckoutError("CHECKOUT_CONFIG_INVALID", "Paddle PricePreview response is invalid.", { offerId });
  }
  return {
    offerId,
    currencyCode: currencyCode as string,
    subtotal: subtotal as string,
    tax: tax as string,
    total: total as string,
    formattedSubtotal: formattedSubtotal as string,
    formattedTax: formattedTax as string,
    formattedTotal: formattedTotal as string,
  };
}
