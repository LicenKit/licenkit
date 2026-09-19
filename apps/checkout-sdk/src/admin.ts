import { createCheckoutCore } from "./core";
import type { LicenKitCheckout, LicenKitCheckoutEvent } from "./types";
import { parseVerificationResponse } from "./validation";

export interface LicenKitVerificationCheckoutOptions {
  /** Authenticated management code owns Session, Origin, and CSRF transport. */
  loadVerificationConfig(): Promise<unknown>;
  onEvent?: (event: LicenKitCheckoutEvent) => void;
}

export function createLicenKitVerificationCheckout(
  options: LicenKitVerificationCheckoutOptions,
): LicenKitCheckout {
  return createCheckoutCore({
    onEvent: options.onEvent,
    async loadConfiguration() {
      return parseVerificationResponse(await options.loadVerificationConfig());
    },
  });
}

