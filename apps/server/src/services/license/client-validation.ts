import { hashDeviceFingerprint } from "../../domain/license/credentials";
import { parseFeatures } from "../../domain/license/terms";
import { createServerValidationMetadata } from "../../domain/license/validation-policy";
import { AppError, NotFoundError } from "../../middleware/error";
import { validateActivation } from "./activation";
import { firstD1 } from "./d1";
import { validateTrial } from "./trial";

export type ClientCredential =
  | {
    kind: "license";
    activationId: string;
    machineToken: string;
  }
  | {
    kind: "trial";
    trialId: string;
    trialToken: string;
  }
  | {
    kind: "none";
  };

interface TrialProductRow {
  status: string;
  trial_enabled: number;
  trial_duration_seconds: number | null;
  trial_features_json: string;
  validation_interval_seconds: number;
}

async function loadProductValidationPolicy(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
}) {
  const product = await firstD1<{ validation_interval_seconds: number }>(input.db.prepare(
    `SELECT validation_interval_seconds FROM products
     WHERE instance_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(input.instanceId, input.productId));
  if (!product) throw new NotFoundError("Product not found");
  return product;
}

async function loadLicenseValidationPolicy(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
  activationId: string;
}) {
  const policy = await firstD1<{
    validation_interval_seconds: number;
    offline_grace_seconds: number;
  }>(input.db.prepare(
    `SELECT p.validation_interval_seconds, l.offline_grace_seconds
     FROM activations a
     JOIN licenses l ON l.instance_id = a.instance_id AND l.id = a.license_id
     JOIN products p ON p.instance_id = l.instance_id AND p.id = l.product_id
     WHERE a.instance_id = ?1 AND l.product_id = ?2 AND a.id = ?3 LIMIT 1`
  ).bind(input.instanceId, input.productId, input.activationId));
  if (!policy) throw new NotFoundError("Activation not found");
  return policy;
}

function releaseNotEligibleState(
  error: unknown,
  release: { version: string; platform: string; arch: string },
) {
  if (!(error instanceof AppError)) return null;
  if (error.code === "UPDATE_ENTITLEMENT_REQUIRED") {
    const updatesUntil = requiredUpdateEntitlementDetail(error, "updates_until");
    const releasedAt = requiredUpdateEntitlementDetail(error, "released_at");
    return {
      kind: "release_not_eligible" as const,
      status: "update_required" as const,
      code: error.code,
      release_version: release.version,
      release_platform: release.platform,
      release_arch: release.arch,
      updates_until: updatesUntil,
      released_at: releasedAt,
      details: {
        license_id: typeof error.details?.license_id === "string" ? error.details.license_id : null,
        updates_until: updatesUntil,
        release_version: typeof error.details?.release_version === "string"
          ? error.details.release_version
          : release.version,
        release_platform: typeof error.details?.release_platform === "string"
          ? error.details.release_platform
          : release.platform,
        release_arch: typeof error.details?.release_arch === "string"
          ? error.details.release_arch
          : release.arch,
        released_at: releasedAt,
      },
    };
  }
  return null;
}

function requiredUpdateEntitlementDetail(
  error: AppError,
  key: "updates_until" | "released_at",
): string {
  const value = error.details?.[key];
  if (typeof value === "string" && value.length > 0) return value;
  throw new AppError(
    "CLIENT_VALIDATION_STATE_CONTRACT_INVALID",
    `UPDATE_ENTITLEMENT_REQUIRED is missing required detail '${key}'.`,
    500,
    {
      source_error_code: error.code,
      missing_detail: key,
    },
    {
      source_error: {
        code: error.code,
        message: error.message,
        details: error.details ?? null,
      },
    },
  );
}

function licenseTerminalState(error: unknown) {
  if (!(error instanceof AppError)) return null;
  switch (error.code) {
    case "LICENSE_EXPIRED":
      return {
        kind: "license" as const,
        status: "expired" as const,
        code: error.code,
        expires_at: typeof error.details?.expires_at === "string" ? error.details.expires_at : null,
        details: {
          license_id: typeof error.details?.license_id === "string" ? error.details.license_id : null,
          expires_at: typeof error.details?.expires_at === "string" ? error.details.expires_at : null,
          billing_period_expires_at: typeof error.details?.billing_period_expires_at === "string"
            ? error.details.billing_period_expires_at
            : null,
          payment_grace_seconds: typeof error.details?.payment_grace_seconds === "number"
            ? error.details.payment_grace_seconds
            : 0,
        },
      };
    case "LICENSE_SUSPENDED":
      return {
        kind: "license" as const,
        status: "suspended" as const,
        code: error.code,
        reason: typeof error.details?.status_reason === "string" ? error.details.status_reason : null,
        details: {
          license_id: typeof error.details?.license_id === "string" ? error.details.license_id : null,
          status_reason: typeof error.details?.status_reason === "string"
            ? error.details.status_reason
            : null,
        },
      };
    case "LICENSE_REVOKED":
      return {
        kind: "license" as const,
        status: "revoked" as const,
        code: error.code,
        reason: typeof error.details?.status_reason === "string" ? error.details.status_reason : null,
        details: {
          license_id: typeof error.details?.license_id === "string" ? error.details.license_id : null,
          status_reason: typeof error.details?.status_reason === "string"
            ? error.details.status_reason
            : null,
        },
      };
    case "ACTIVATION_REVOKED":
      return {
        kind: "license" as const,
        status: "activation_revoked" as const,
        code: error.code,
        details: {
          activation_id: typeof error.details?.activation_id === "string"
            ? error.details.activation_id
            : null,
        },
      };
    case "ACTIVATION_DEACTIVATED":
      return {
        kind: "license" as const,
        status: "activation_deactivated" as const,
        code: error.code,
        details: {
          activation_id: typeof error.details?.activation_id === "string"
            ? error.details.activation_id
            : null,
        },
      };
    default:
      return null;
  }
}

function trialTerminalState(error: unknown) {
  if (!(error instanceof AppError)) return null;
  if (error.code === "TRIAL_EXPIRED") {
    return {
      kind: "trial" as const,
      status: "expired" as const,
      code: error.code,
      expires_at: typeof error.details?.expires_at === "string" ? error.details.expires_at : null,
      details: {
        trial_id: typeof error.details?.trial_id === "string" ? error.details.trial_id : null,
        expires_at: typeof error.details?.expires_at === "string" ? error.details.expires_at : null,
      },
    };
  }
  if (error.code === "TRIAL_REVOKED") {
    return {
      kind: "trial" as const,
      status: "revoked" as const,
      code: error.code,
      reason: typeof error.details?.revoke_reason === "string" ? error.details.revoke_reason : null,
      details: {
        trial_id: typeof error.details?.trial_id === "string" ? error.details.trial_id : null,
        revoked_at: typeof error.details?.revoked_at === "string" ? error.details.revoked_at : null,
        revoke_reason: typeof error.details?.revoke_reason === "string"
          ? error.details.revoke_reason
          : null,
      },
    };
  }
  return null;
}

async function validateLicenseCredential(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string };
  instanceId: string;
  productId: string;
  fingerprint: string;
  releaseVersion: string;
  releasePlatform: string;
  releaseArch: string;
  credential: Extract<ClientCredential, { kind: "license" }>;
  now: Date;
}) {
  try {
    const data = await validateActivation({
      db: input.db,
      env: input.env,
      instanceId: input.instanceId,
      productId: input.productId,
      activationId: input.credential.activationId,
      machineToken: input.credential.machineToken,
      fingerprint: input.fingerprint,
      releaseVersion: input.releaseVersion,
      releasePlatform: input.releasePlatform,
      releaseArch: input.releaseArch,
      now: input.now,
    });
    return {
      state: data.state,
      credential_update: {
        credential_mode: data.credential_mode,
        signed_license_token: data.signed_license_token,
        signing_key_id: data.signing_key_id,
      },
      validation: data.validation,
    };
  } catch (error) {
    const state = licenseTerminalState(error)
      ?? releaseNotEligibleState(error, {
        version: input.releaseVersion,
        platform: input.releasePlatform,
        arch: input.releaseArch,
      });
    if (!state) throw error;
    const policy = await loadLicenseValidationPolicy({
      db: input.db,
      instanceId: input.instanceId,
      productId: input.productId,
      activationId: input.credential.activationId,
    });
    return {
      state,
      validation: createServerValidationMetadata({
        validatedAt: input.now,
        validationIntervalSeconds: policy.validation_interval_seconds,
        offlineGraceSeconds: policy.offline_grace_seconds,
      }),
    };
  }
}

async function validateTrialCredential(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
  fingerprint: string;
  credential: Extract<ClientCredential, { kind: "trial" }>;
  now: Date;
}) {
  try {
    const data = await validateTrial({
      db: input.db,
      instanceId: input.instanceId,
      productId: input.productId,
      trialId: input.credential.trialId,
      trialToken: input.credential.trialToken,
      fingerprint: input.fingerprint,
      now: input.now,
    });
    return {
      state: data.state,
      validation: data.validation,
    };
  } catch (error) {
    const state = trialTerminalState(error);
    if (!state) throw error;
    const policy = await loadProductValidationPolicy(input);
    return {
      state,
      validation: createServerValidationMetadata({
        validatedAt: input.now,
        validationIntervalSeconds: policy.validation_interval_seconds,
        offlineGraceSeconds: null,
      }),
    };
  }
}

async function validateWithoutCredential(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
  fingerprint: string;
  releaseVersion: string;
  releasePlatform: string;
  releaseArch: string;
  now: Date;
}) {
  const product = await firstD1<TrialProductRow>(input.db.prepare(
    `SELECT status, trial_enabled, trial_duration_seconds, trial_features_json,
            validation_interval_seconds
     FROM products WHERE instance_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(input.instanceId, input.productId));
  if (!product) throw new NotFoundError("Product not found");

  const validation = createServerValidationMetadata({
    validatedAt: input.now,
    validationIntervalSeconds: product.validation_interval_seconds,
    offlineGraceSeconds: null,
  });
  if (product.status !== "active") {
    throw new AppError("PRODUCT_UNAVAILABLE", "The Product is archived.", 409);
  }

  if (!product.trial_enabled) {
    return {
      state: {
        kind: "activation_required" as const,
        trial: {
          status: "unavailable" as const,
          reason: "not_enabled" as const,
          code: "TRIAL_NOT_ENABLED" as const,
        },
      },
      validation,
    };
  }
  if (!product.trial_duration_seconds || product.trial_duration_seconds <= 0) {
    throw new AppError("TRIAL_CONFIGURATION_INVALID", "The Product trial duration is invalid.", 500);
  }

  const fingerprintHash = await hashDeviceFingerprint(input.fingerprint);
  const existing = await firstD1<{ found: number }>(input.db.prepare(
    `SELECT 1 AS found FROM trial_claims
     WHERE instance_id = ?1 AND product_id = ?2 AND fingerprint_hash = ?3 LIMIT 1`
  ).bind(input.instanceId, input.productId, fingerprintHash));
  if (existing) {
    return {
      state: {
        kind: "activation_required" as const,
        trial: {
          status: "unavailable" as const,
          reason: "already_claimed" as const,
          code: "TRIAL_ALREADY_CLAIMED" as const,
        },
      },
      validation,
    };
  }

  return {
    state: {
      kind: "activation_required" as const,
      trial: {
        status: "available" as const,
        duration_seconds: product.trial_duration_seconds,
        features: parseFeatures(product.trial_features_json),
      },
    },
    validation,
  };
}

export async function validateClient(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string };
  instanceId: string;
  productId: string;
  fingerprint: string;
  releaseVersion: string;
  releasePlatform: string;
  releaseArch: string;
  credential: ClientCredential;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (input.credential.kind === "license") {
    return validateLicenseCredential({ ...input, credential: input.credential, now });
  }
  if (input.credential.kind === "trial") {
    return validateTrialCredential({ ...input, credential: input.credential, now });
  }
  return validateWithoutCredential({ ...input, now });
}
