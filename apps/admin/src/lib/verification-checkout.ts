import { createLicenKitVerificationCheckout } from "@licenkit/checkout/admin";
import type { LicenKitCheckout } from "@licenkit/checkout";

type VerificationCheckoutFactory = (options: {
  loadVerificationConfig(): Promise<unknown>;
}) => LicenKitCheckout;

export async function openVerificationCheckout(
  offerId: string,
  loadVerificationConfig: () => Promise<unknown>,
  createCheckout: VerificationCheckoutFactory = createLicenKitVerificationCheckout,
): Promise<void> {
  const checkout = createCheckout({ loadVerificationConfig });
  try {
    await checkout.load();
    await checkout.open({ offerId });
  } finally {
    checkout.destroy();
  }
}
