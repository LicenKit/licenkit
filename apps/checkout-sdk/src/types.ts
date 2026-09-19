export interface LicenKitCheckoutOptions {
  licenkitBaseUrl: string;
  accountSlug: string;
  productSlug: string;
  onEvent?: (event: LicenKitCheckoutEvent) => void;
}

export interface PublicOffer {
  id: string;
  name: string;
  purchaseType: "one_time" | "subscription";
}

export interface LocalizedPrice {
  offerId: string;
  currencyCode: string;
  subtotal: string;
  tax: string;
  total: string;
  formattedSubtotal: string;
  formattedTax: string;
  formattedTotal: string;
}

export interface CheckoutState {
  product: { slug: string; name: string; description?: string };
  available: boolean;
  reasonCodes: string[];
  offers: PublicOffer[];
}

export interface OpenCheckoutOptions {
  offerId: string;
  successUrl?: string;
}

export type LicenKitCheckoutEvent =
  | { type: "checkout.loaded" }
  | { type: "checkout.completed"; transactionId?: string }
  | { type: "checkout.closed" }
  | { type: "checkout.error"; code: string };

export interface LicenKitCheckout {
  load(): Promise<CheckoutState>;
  previewPrices(offerIds?: string[]): Promise<LocalizedPrice[]>;
  open(options: OpenCheckoutOptions): Promise<void>;
  destroy(): void;
}

export type CheckoutErrorCode =
  | "CHECKOUT_CONFIG_UNAVAILABLE"
  | "CHECKOUT_CONFIG_INVALID"
  | "CHECKOUT_NOT_AVAILABLE"
  | "CHECKOUT_OFFER_NOT_FOUND"
  | "PADDLE_INITIALIZATION_FAILED"
  | "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE"
  | "PADDLE_CHECKOUT_FAILED"
  | "CHECKOUT_DESTROYED";

export class LicenKitCheckoutError extends Error {
  readonly code: CheckoutErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CheckoutErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "LicenKitCheckoutError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface InternalOffer extends PublicOffer {
  priceId: string;
  quantity: 1;
}

export interface InternalCheckoutConfiguration {
  product: CheckoutState["product"];
  available: boolean;
  reasonCodes: string[];
  provider?: "paddle";
  environment?: "sandbox" | "live";
  clientSideToken?: string;
  offers: InternalOffer[];
  verificationToken?: string;
}

