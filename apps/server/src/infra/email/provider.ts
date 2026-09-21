import type { EmailVariableValue } from "../../domain/email/contracts";
import { AppError } from "../../middleware/error";
import { resendEmailProviderAdapter } from "./resend";

export interface ProviderCredential {
  readonly version: number;
}

export interface EmailProviderSendInput {
  readonly credential: ProviderCredential;
  readonly from: string;
  readonly to: string;
  readonly replyTo?: string;
  readonly templateRef: string;
  readonly variables: Readonly<Record<string, EmailVariableValue>>;
  readonly idempotencyKey: string;
}

export interface EmailProviderSendResult {
  readonly providerMessageId: string;
  readonly providerRequestId?: string;
  readonly httpStatus: number;
  readonly responseHeadersRedacted?: Readonly<Record<string, string>>;
  readonly responseBodyRedacted?: string;
}

export type EmailProviderErrorAction =
  | "retry"
  | "block_integration"
  | "block_binding"
  | "fail_delivery";

export type EmailProviderFailureClass =
  | "authentication"
  | "configuration"
  | "quota"
  | "rate_limit"
  | "provider"
  | "transport"
  | "timeout"
  | "consistency";

export interface EmailProviderErrorClassification {
  readonly action: EmailProviderErrorAction;
  readonly failureClass: EmailProviderFailureClass;
  readonly httpStatus?: number;
  readonly providerErrorType?: string;
  readonly providerErrorCode?: string;
  readonly providerErrorDetail?: string;
  readonly providerRequestId?: string;
  readonly retryAfter?: string;
  readonly responseHeadersRedacted?: Readonly<Record<string, string>>;
  readonly responseBodyRedacted?: string;
}

export interface EmailProviderAdapter {
  readonly provider: string;

  validateCredentialEnvelope(value: unknown): ProviderCredential;

  validateSendInput(
    input: Omit<EmailProviderSendInput, "credential" | "idempotencyKey">,
  ): void;

  send(input: EmailProviderSendInput): Promise<EmailProviderSendResult>;

  classifyError(error: unknown): EmailProviderErrorClassification;
}

export const EMAIL_PROVIDER_ADAPTERS: Readonly<
  Record<string, EmailProviderAdapter>
> = Object.freeze({
  resend: resendEmailProviderAdapter,
});

export function getEmailProviderAdapter(provider: string): EmailProviderAdapter {
  if (!Object.prototype.hasOwnProperty.call(EMAIL_PROVIDER_ADAPTERS, provider)) {
    throw new AppError(
      "EMAIL_PROVIDER_NOT_REGISTERED",
      "The requested email Provider is not registered.",
      404,
      { provider },
    );
  }
  return EMAIL_PROVIDER_ADAPTERS[provider];
}
