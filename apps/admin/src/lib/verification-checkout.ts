import type { BillingVerificationConfig, SuccessEnvelope } from "./api-client";

export interface PaddleRuntime {
  Environment?: { set(value: "sandbox"): void };
  Setup(options: { token: string }): void;
  Checkout: { open(options: Record<string, unknown>): void };
}

declare global {
  interface Window { Paddle?: PaddleRuntime }
}

let loadPromise: Promise<PaddleRuntime> | null = null;
let initializedToken: string | null = null;

function invalid(message: string): never {
  throw new Error(`PADDLE_VERIFICATION_CONFIG_INVALID: ${message}`);
}

function parseVerificationConfig(value: unknown): BillingVerificationConfig {
  if (!value || typeof value !== "object") invalid("Expected a response envelope.");
  const envelope = value as Record<string, unknown>;
  if (envelope.success !== true || !envelope.data || typeof envelope.data !== "object") {
    invalid("The verification response was not successful.");
  }
  const data = envelope.data as Record<string, unknown>;
  const checkout = data.checkout;
  if (data.verificationMode !== true || typeof data.verificationToken !== "string" || !data.verificationToken.startsWith("vfy_")) {
    invalid("The verification token is missing or invalid.");
  }
  if (typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt))) {
    invalid("The verification expiry is invalid.");
  }
  if (!checkout || typeof checkout !== "object") invalid("The Paddle configuration is missing.");
  const paddle = checkout as Record<string, unknown>;
  if (
    paddle.provider !== "paddle"
    || paddle.environment !== "sandbox"
    || typeof paddle.clientSideToken !== "string"
    || !paddle.clientSideToken.startsWith("test_")
    || typeof paddle.priceId !== "string"
    || !/^pri_[A-Za-z0-9]+$/.test(paddle.priceId)
    || paddle.quantity !== 1
  ) {
    invalid("The response must contain one Paddle Sandbox Price with quantity 1.");
  }
  return data as unknown as BillingVerificationConfig;
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
    throw error;
  }
}

async function initializedPaddle(token: string, loadPaddle: () => Promise<PaddleRuntime>): Promise<PaddleRuntime> {
  const paddle = await loadPaddle();
  if (initializedToken && initializedToken !== token) {
    throw new Error("PADDLE_INITIALIZATION_FAILED: Paddle.js is already initialized with another Sandbox token.");
  }
  if (!initializedToken) {
    paddle.Environment?.set("sandbox");
    paddle.Setup({ token });
    initializedToken = token;
  }
  return paddle;
}

export async function openVerificationCheckout(
  loadVerificationConfig: () => Promise<SuccessEnvelope<BillingVerificationConfig>>,
  loadPaddle: () => Promise<PaddleRuntime> = loadOfficialPaddleJs,
): Promise<void> {
  const response = await loadVerificationConfig();
  const config = parseVerificationConfig(response);
  const paddle = await initializedPaddle(config.checkout.clientSideToken, loadPaddle);
  try {
    paddle.Checkout.open({
      items: [{ priceId: config.checkout.priceId, quantity: 1 }],
      customData: { licenkit_checkout_verification: config.verificationToken },
    });
  } finally {
    config.verificationToken = "";
  }
}
