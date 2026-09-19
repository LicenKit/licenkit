import {
  initializePaddle,
  paddleProviderErrorDetails,
  parsePricePreview,
  removePaddleListener,
} from "./paddle-runtime";
import type {
  CheckoutState,
  InternalCheckoutConfiguration,
  LicenKitCheckout,
  LicenKitCheckoutEvent,
  LocalizedPrice,
  OpenCheckoutOptions,
} from "./types";
import { LicenKitCheckoutError } from "./types";
import { validateSuccessUrl } from "./validation";

export function createCheckoutCore(input: {
  loadConfiguration(): Promise<InternalCheckoutConfiguration>;
  onEvent?: (event: LicenKitCheckoutEvent) => void;
}): LicenKitCheckout {
  let destroyed = false;
  let configuration: InternalCheckoutConfiguration | null = null;
  const listener = (event: LicenKitCheckoutEvent) => input.onEvent?.(event);

  function assertAlive(): void {
    if (destroyed) throw new LicenKitCheckoutError("CHECKOUT_DESTROYED", "Checkout instance was destroyed.");
  }

  async function config(): Promise<InternalCheckoutConfiguration> {
    assertAlive();
    configuration = await input.loadConfiguration();
    return configuration;
  }

  async function paddle() {
    const current = configuration ?? await config();
    if (!current.available || !current.environment || !current.clientSideToken) {
      throw new LicenKitCheckoutError("CHECKOUT_NOT_AVAILABLE", "Checkout is not currently available.", {
        reasonCodes: current.reasonCodes,
      });
    }
    return initializePaddle(current.environment, current.clientSideToken, listener);
  }

  return {
    async load(): Promise<CheckoutState> {
      const current = await config();
      return {
        product: { ...current.product },
        available: current.available,
        reasonCodes: [...current.reasonCodes],
        offers: current.offers.map(({ id, name, purchaseType }) => ({ id, name, purchaseType })),
      };
    },

    async previewPrices(offerIds?: string[]): Promise<LocalizedPrice[]> {
      assertAlive();
      const current = configuration ?? await config();
      if (!current.available) throw new LicenKitCheckoutError("CHECKOUT_NOT_AVAILABLE", "Checkout is not currently available.", { reasonCodes: current.reasonCodes });
      const selected = offerIds === undefined
        ? current.offers
        : offerIds.map((id) => {
            const offer = current.offers.find((candidate) => candidate.id === id);
            if (!offer) throw new LicenKitCheckoutError("CHECKOUT_OFFER_NOT_FOUND", "Offer is not part of the current Checkout configuration.", { offerId: id });
            return offer;
          });
      const runtime = await paddle();
      return Promise.all(selected.map(async (offer) => parsePricePreview(
        offer.id,
        await runtime.PricePreview({ items: [{ priceId: offer.priceId, quantity: 1 }] }),
      )));
    },

    async open(options: OpenCheckoutOptions): Promise<void> {
      assertAlive();
      const current = configuration ?? await config();
      if (!current.available) throw new LicenKitCheckoutError("CHECKOUT_NOT_AVAILABLE", "Checkout is not currently available.", { reasonCodes: current.reasonCodes });
      const offer = current.offers.find((candidate) => candidate.id === options.offerId);
      if (!offer) throw new LicenKitCheckoutError("CHECKOUT_OFFER_NOT_FOUND", "Offer is not part of the current Checkout configuration.", { offerId: options.offerId });
      const successUrl = validateSuccessUrl(options.successUrl, current.environment!);
      const runtime = await paddle();
      try {
        runtime.Checkout.open({
          items: [{ priceId: offer.priceId, quantity: 1 }],
          ...(successUrl ? { settings: { successUrl } } : {}),
          ...(current.verificationToken
            ? { customData: { licenkit_checkout_verification: current.verificationToken } }
            : {}),
        });
        if (current.verificationToken) configuration = { ...current, verificationToken: undefined };
      } catch (error) {
        const details = paddleProviderErrorDetails(error, current.environment!);
        const message = typeof details.providerMessage === "string" ? details.providerMessage : "";
        const originError = /origin|domain|default payment link|website/i.test(message);
        throw new LicenKitCheckoutError(
          originError ? "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE" : "PADDLE_CHECKOUT_FAILED",
          "Paddle Checkout failed to open.",
          details,
        );
      }
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (configuration?.verificationToken) configuration = { ...configuration, verificationToken: undefined };
      removePaddleListener(listener);
    },
  };
}
