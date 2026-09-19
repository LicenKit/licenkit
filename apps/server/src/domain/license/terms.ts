import { AppError } from "../../middleware/error";

export type LicenseModel = "perpetual" | "fixed_term" | "subscription";
export type RenewalMode = "none" | "manual" | "billing";
export type CredentialMode = "opaque" | "signed";

export interface LicensePlanSnapshot {
  id: string;
  revision: number;
  licenseModel: LicenseModel;
  credentialMode: CredentialMode;
  defaultTermSeconds: number | null;
  updateWindowSeconds: number | null;
  signedTokenTtlSeconds: number;
  paymentGraceSeconds: number;
  maxActivations: number;
  featuresJson: string;
}

export interface ResolvedManualTerms {
  planId: string;
  planRevision: number;
  licenseModel: LicenseModel;
  renewalMode: RenewalMode;
  credentialMode: CredentialMode;
  signedTokenTtlSeconds: number;
  paymentGraceSeconds: number;
  maxActivations: number;
  featuresJson: string;
  expiresAt: string | null;
  updatesUntil: string | null;
}

export function parseIsoInstant(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError("VALIDATION_ERROR", `${field} must be a valid ISO-8601 instant.`, 400, {
      field,
    });
  }
  return date;
}

export function resolveManualTerms(
  plan: LicensePlanSnapshot,
  issuedAt: Date,
  requestedExpiresAt: string | null | undefined,
): ResolvedManualTerms {
  const issuedAtMs = issuedAt.getTime();
  let renewalMode: RenewalMode = "none";
  let expiresAt: string | null = null;
  let updatesUntil: string | null = null;

  if (plan.licenseModel === "perpetual") {
    if (requestedExpiresAt !== undefined && requestedExpiresAt !== null) {
      throw new AppError(
        "PERPETUAL_LICENSE_EXPIRES_AT_FORBIDDEN",
        "A perpetual License cannot have expiresAt.",
        400,
      );
    }
    if (plan.updateWindowSeconds !== null) {
      updatesUntil = new Date(issuedAtMs + plan.updateWindowSeconds * 1000).toISOString();
    }
  } else if (plan.licenseModel === "fixed_term") {
    if (requestedExpiresAt !== undefined) {
      throw new AppError(
        "FIXED_TERM_EXPIRES_AT_SERVER_MANAGED",
        "A fixed-term License expiry is calculated from its License Plan.",
        400,
      );
    }
    if (!plan.defaultTermSeconds || plan.defaultTermSeconds <= 0) {
      throw new AppError(
        "LICENSE_PLAN_TERM_INVALID",
        "The fixed-term License Plan does not define a positive default term.",
        409,
        { license_plan_id: plan.id },
      );
    }
    expiresAt = new Date(issuedAtMs + plan.defaultTermSeconds * 1000).toISOString();
  } else {
    renewalMode = "manual";
    if (!requestedExpiresAt) {
      throw new AppError(
        "MANUAL_SUBSCRIPTION_EXPIRES_AT_REQUIRED",
        "A manually issued subscription requires a future expiresAt.",
        400,
      );
    }
    const requested = parseIsoInstant(requestedExpiresAt, "expiresAt");
    if (requested.getTime() <= issuedAtMs) {
      throw new AppError(
        "MANUAL_SUBSCRIPTION_EXPIRES_AT_INVALID",
        "A manually issued subscription requires a future expiresAt.",
        400,
      );
    }
    expiresAt = requested.toISOString();
  }

  return {
    planId: plan.id,
    planRevision: plan.revision,
    licenseModel: plan.licenseModel,
    renewalMode,
    credentialMode: plan.credentialMode,
    signedTokenTtlSeconds: plan.signedTokenTtlSeconds,
    paymentGraceSeconds: 0,
    maxActivations: plan.maxActivations,
    featuresJson: plan.featuresJson,
    expiresAt,
    updatesUntil,
  };
}

export function parseFeatures(featuresJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(featuresJson);
  } catch (error) {
    throw new AppError(
      "LICENSE_TERMS_FEATURES_INVALID",
      "The stored License features snapshot is invalid.",
      500,
      undefined,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new AppError(
      "LICENSE_TERMS_FEATURES_INVALID",
      "The stored License features snapshot is invalid.",
      500,
    );
  }
  return parsed;
}
