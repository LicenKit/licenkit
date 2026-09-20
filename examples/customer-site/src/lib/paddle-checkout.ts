import type { PaddleEnvironment } from "../site-config";

export type PaddleCheckoutErrorCode =
  | "PADDLE_CONFIG_INVALID"
  | "PADDLE_INITIALIZATION_FAILED"
  | "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE"
  | "PADDLE_CHECKOUT_FAILED";

export class PaddleCheckoutError extends Error {
  readonly code: PaddleCheckoutErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: PaddleCheckoutErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PaddleCheckoutError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

interface PaddleRuntime {
  Environment?: { set(value: "sandbox"): void };
  Setup(options: { token: string }): void;
  Checkout: { open(options: Record<string, unknown>): void };
}

declare global {
  interface Window { Paddle?: PaddleRuntime }
}

let loadPromise: Promise<PaddleRuntime> | null = null;
let initializedKey: string | null = null;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function firstText(records: Array<Record<string, unknown> | null>, names: string[]): string | undefined {
  for (const item of records) {
    if (!item) continue;
    for (const name of names) {
      const value = item[name];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function providerErrorDetails(error: unknown, environment: PaddleEnvironment): Record<string, unknown> {
  const root = record(error);
  const nested = record(root?.error);
  const data = record(root?.data);
  const response = record(root?.response);
  const responseData = record(response?.data);
  const records = [root, nested, data, responseData];
  const providerCode = firstText(records, ["code", "errorCode", "error_code"]);
  const providerRequestId = firstText(records, ["requestId", "request_id", "request-id"]);
  const providerMessage = error instanceof Error ? error.message : firstText(records, ["message", "detail"]);
  return {
    environment,
    ...(providerCode ? { providerCode: providerCode.slice(0, 200) } : {}),
    ...(providerRequestId ? { providerRequestId: providerRequestId.slice(0, 200) } : {}),
    ...(providerMessage ? { providerMessage: providerMessage.slice(0, 500) } : {}),
  };
}

async function loadOfficialPaddleJs(): Promise<PaddleRuntime> {
  if (window.Paddle) return window.Paddle;
  if (!loadPromise) {
    loadPromise = new Promise<PaddleRuntime>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
      script.async = true;
      script.onload = () => window.Paddle ? resolve(window.Paddle) : reject(new Error("Paddle global was not created."));
      script.onerror = () => reject(new Error("Official Paddle.js failed to load."));
      document.head.appendChild(script);
    });
  }
  try {
    return await loadPromise;
  } catch (error) {
    loadPromise = null;
    throw new PaddleCheckoutError("PADDLE_INITIALIZATION_FAILED", "Official Paddle.js failed to load.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function initializePaddle(environment: PaddleEnvironment, clientSideToken: string): Promise<PaddleRuntime> {
  const expectedPrefix = environment === "sandbox" ? "test_" : "live_";
  if (!clientSideToken.startsWith(expectedPrefix) || clientSideToken.length > 512) {
    throw new PaddleCheckoutError("PADDLE_CONFIG_INVALID", "Paddle Client-side Token does not match the configured environment.");
  }
  const paddle = await loadOfficialPaddleJs();
  const key = `${environment}:${clientSideToken}`;
  if (initializedKey && initializedKey !== key) {
    throw new PaddleCheckoutError("PADDLE_INITIALIZATION_FAILED", "Paddle.js is already initialized with another environment or token.", { environment });
  }
  if (!initializedKey) {
    if (environment === "sandbox") paddle.Environment?.set("sandbox");
    try {
      paddle.Setup({ token: clientSideToken });
      initializedKey = key;
    } catch (error) {
      const details = providerErrorDetails(error, environment);
      const providerMessage = typeof details.providerMessage === "string" ? details.providerMessage : "";
      throw new PaddleCheckoutError(
        /origin|domain|default payment link|website/i.test(providerMessage)
          ? "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE"
          : "PADDLE_INITIALIZATION_FAILED",
        "Paddle.js initialization failed.",
        details,
      );
    }
  }
  return paddle;
}

function validateSuccessUrl(value: string, environment: PaddleEnvironment): string {
  let url: URL;
  try { url = new URL(value, location.href); }
  catch { throw new PaddleCheckoutError("PADDLE_CONFIG_INVALID", "Checkout success URL is invalid."); }
  const sandboxLocalhost = environment === "sandbox" && url.protocol === "http:" && (
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  );
  if ((url.protocol !== "https:" && !sandboxLocalhost) || url.origin !== location.origin || url.username || url.password) {
    throw new PaddleCheckoutError("PADDLE_CONFIG_INVALID", "Checkout success URL must be a same-origin HTTPS URL.");
  }
  return url.href;
}

export async function openPaddleCheckout(input: {
  environment: PaddleEnvironment;
  clientSideToken: string;
  priceId: string;
  successUrl: string;
}): Promise<void> {
  if (!/^pri_[A-Za-z0-9]+$/.test(input.priceId)) {
    throw new PaddleCheckoutError("PADDLE_CONFIG_INVALID", "Paddle Price ID is invalid.", { priceId: input.priceId });
  }
  const paddle = await initializePaddle(input.environment, input.clientSideToken);
  try {
    paddle.Checkout.open({
      items: [{ priceId: input.priceId, quantity: 1 }],
      settings: { successUrl: validateSuccessUrl(input.successUrl, input.environment) },
    });
  } catch (error) {
    const details = providerErrorDetails(error, input.environment);
    const providerMessage = typeof details.providerMessage === "string" ? details.providerMessage : "";
    throw new PaddleCheckoutError(
      /origin|domain|default payment link|website/i.test(providerMessage)
        ? "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE"
        : "PADDLE_CHECKOUT_FAILED",
      "Paddle Checkout failed to open.",
      details,
    );
  }
}
