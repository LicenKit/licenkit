import type { ProviderHttpErrorDetails } from "./types";

export type BillingFailureDisposition = "retry" | "needs_attention" | "failed";

export class BillingProcessingError extends Error {
  readonly code: string;
  readonly disposition: BillingFailureDisposition;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    disposition: BillingFailureDisposition,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BillingProcessingError";
    this.code = code;
    this.disposition = disposition;
    this.details = details;
  }
}

export class PaddleHttpError extends BillingProcessingError {
  readonly providerDetails: ProviderHttpErrorDetails;

  constructor(
    code: string,
    message: string,
    disposition: BillingFailureDisposition,
    providerDetails: ProviderHttpErrorDetails,
  ) {
    super(code, message, disposition, { provider: providerDetails });
    this.name = "PaddleHttpError";
    this.providerDetails = providerDetails;
  }
}

