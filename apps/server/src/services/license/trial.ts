import { ulid } from "ulid";
import { AppError, NotFoundError } from "../../middleware/error";
import { timingSafeEqual } from "../../infra/crypto";
import { hashDeviceFingerprint } from "../../domain/license/credentials";
import { parseFeatures } from "../../domain/license/terms";
import { createServerValidationMetadata } from "../../domain/license/validation-policy";
import { firstD1 } from "./d1";

interface TrialProductRow {
  status: string;
  trial_enabled: number;
  trial_duration_seconds: number | null;
  trial_features_json: string;
  validation_interval_seconds: number;
}

interface TrialClaimRow {
  id: string;
  fingerprint_hash: string;
  features_json: string;
  claimed_at: string;
  expires_at: string;
  last_validated_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

function trialResponse(input: {
  claim: TrialClaimRow;
  validatedAt: Date;
  validationIntervalSeconds: number;
}) {
  const features = parseFeatures(input.claim.features_json);
  const validation = createServerValidationMetadata({
    validatedAt: input.validatedAt,
    validationIntervalSeconds: input.validationIntervalSeconds,
    offlineGraceSeconds: null,
  });
  if (input.claim.revoked_at) {
    return {
      trial_id: input.claim.id,
      status: "revoked" as const,
      expires_at: input.claim.expires_at,
      features,
      state: {
        kind: "trial" as const,
        status: "revoked" as const,
        code: "TRIAL_REVOKED" as const,
        reason: input.claim.revoke_reason,
        expires_at: input.claim.expires_at,
        features,
      },
      validation,
    };
  }
  if (input.validatedAt.getTime() >= Date.parse(input.claim.expires_at)) {
    return {
      trial_id: input.claim.id,
      status: "expired" as const,
      expires_at: input.claim.expires_at,
      features,
      state: {
        kind: "trial" as const,
        status: "expired" as const,
        code: "TRIAL_EXPIRED" as const,
        expires_at: input.claim.expires_at,
        features,
      },
      validation,
    };
  }
  return {
    trial_id: input.claim.id,
    status: "active" as const,
    expires_at: input.claim.expires_at,
    features,
    state: {
      kind: "trial" as const,
      status: "active" as const,
      expires_at: input.claim.expires_at,
      features,
    },
    validation,
  };
}

async function reissueTrialClaim(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
  fingerprintHash: string;
  validationIntervalSeconds: number;
  now: Date;
}) {
  const claim = await firstD1<TrialClaimRow>(input.db.prepare(
    `SELECT id, fingerprint_hash, features_json, claimed_at,
            expires_at, last_validated_at, revoked_at, revoke_reason
     FROM trial_claims
     WHERE instance_id = ?1 AND product_id = ?2 AND fingerprint_hash = ?3 LIMIT 1`
  ).bind(input.instanceId, input.productId, input.fingerprintHash));
  if (!claim) throw new NotFoundError("Trial Claim not found");
  if (!claim.revoked_at && input.now.getTime() < Date.parse(claim.expires_at)) {
    await input.db.prepare(
      `UPDATE trial_claims SET last_validated_at = ?1, updated_at = ?1
       WHERE instance_id = ?2 AND product_id = ?3 AND id = ?4
         AND fingerprint_hash = ?5 AND revoked_at IS NULL AND expires_at > ?1`
    ).bind(
      input.now.toISOString(),
      input.instanceId,
      input.productId,
      claim.id,
      input.fingerprintHash,
    ).run();
  }
  return trialResponse({
    claim,
    validatedAt: input.now,
    validationIntervalSeconds: input.validationIntervalSeconds,
  });
}

export async function claimTrial(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
  fingerprint: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const product = await firstD1<TrialProductRow>(input.db.prepare(
    `SELECT status, trial_enabled, trial_duration_seconds, trial_features_json,
            validation_interval_seconds
     FROM products WHERE instance_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(input.instanceId, input.productId));
  if (!product) throw new NotFoundError("Product not found");
  if (product.status !== "active") throw new AppError("PRODUCT_UNAVAILABLE", "The Product is archived.", 409);
  if (!product.trial_enabled) throw new AppError("TRIAL_NOT_ENABLED", "This Product does not offer a device trial.", 404);
  if (!product.trial_duration_seconds || product.trial_duration_seconds <= 0) {
    throw new AppError("TRIAL_CONFIGURATION_INVALID", "The Product trial duration is invalid.", 500);
  }
  const fingerprintHash = await hashDeviceFingerprint(input.fingerprint);
  const existing = await firstD1<{ found: number }>(input.db.prepare(
    `SELECT 1 AS found FROM trial_claims
     WHERE instance_id = ?1 AND product_id = ?2 AND fingerprint_hash = ?3 LIMIT 1`
  ).bind(input.instanceId, input.productId, fingerprintHash));
  if (existing) return reissueTrialClaim({
    db: input.db,
    instanceId: input.instanceId,
    productId: input.productId,
    fingerprintHash,
    validationIntervalSeconds: product.validation_interval_seconds,
    now,
  });

  const trialId = `trl_${ulid().toLowerCase()}`;
  const expiresAt = new Date(now.getTime() + product.trial_duration_seconds * 1000).toISOString();
  try {
    await input.db.prepare(
      `INSERT INTO trial_claims (
         id, instance_id, product_id, fingerprint_hash,
         features_json, claimed_at, expires_at, last_validated_at,
         revoked_at, revoke_reason, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, NULL, NULL, ?6)`
    ).bind(
      trialId,
      input.instanceId,
      input.productId,
      fingerprintHash,
      product.trial_features_json,
      now.toISOString(),
      expiresAt,
    ).run();
  } catch (error) {
    const persistedForDevice = await firstD1<{ found: number }>(input.db.prepare(
      `SELECT 1 AS found FROM trial_claims
       WHERE instance_id = ?1 AND product_id = ?2 AND fingerprint_hash = ?3 LIMIT 1`
    ).bind(input.instanceId, input.productId, fingerprintHash));
    if (persistedForDevice) {
      return reissueTrialClaim({
        db: input.db,
        instanceId: input.instanceId,
        productId: input.productId,
        fingerprintHash,
        validationIntervalSeconds: product.validation_interval_seconds,
        now,
      });
    }
    throw error;
  }
  return trialResponse({
    claim: {
      id: trialId,
      fingerprint_hash: fingerprintHash,
      features_json: product.trial_features_json,
      claimed_at: now.toISOString(),
      expires_at: expiresAt,
      last_validated_at: now.toISOString(),
      revoked_at: null,
      revoke_reason: null,
    },
    validatedAt: now,
    validationIntervalSeconds: product.validation_interval_seconds,
  });
}

export async function validateTrial(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
  trialId: string;
  fingerprint: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const claim = await firstD1<TrialClaimRow & { validation_interval_seconds: number }>(input.db.prepare(
    `SELECT tc.id, tc.fingerprint_hash, tc.features_json, tc.claimed_at,
            tc.expires_at, tc.last_validated_at, tc.revoked_at, tc.revoke_reason,
            p.validation_interval_seconds
     FROM trial_claims tc
     JOIN products p ON p.instance_id = tc.instance_id AND p.id = tc.product_id
     WHERE tc.instance_id = ?1 AND tc.product_id = ?2 AND tc.id = ?3 LIMIT 1`
  ).bind(input.instanceId, input.productId, input.trialId));
  if (!claim) throw new NotFoundError("Trial Claim not found");
  const fingerprintHash = await hashDeviceFingerprint(input.fingerprint);
  if (!timingSafeEqual(fingerprintHash, claim.fingerprint_hash)) {
    throw new AppError("TRIAL_CREDENTIALS_INVALID", "The Trial Claim credentials are invalid.", 401);
  }
  if (claim.revoked_at) {
    throw new AppError("TRIAL_REVOKED", "The Trial Claim has been revoked.", 403, {
      trial_id: claim.id,
      revoked_at: claim.revoked_at,
      revoke_reason: claim.revoke_reason,
    });
  }
  if (now.getTime() > Date.parse(claim.expires_at)) {
    throw new AppError("TRIAL_EXPIRED", "The Trial Claim has expired.", 403, {
      trial_id: claim.id,
      expires_at: claim.expires_at,
    });
  }
  const refreshed = await input.db.prepare(
    `UPDATE trial_claims SET last_validated_at = ?1, updated_at = ?1
     WHERE instance_id = ?2 AND product_id = ?3 AND id = ?4
       AND revoked_at IS NULL AND expires_at > ?1`
  ).bind(now.toISOString(), input.instanceId, input.productId, input.trialId).run();
  if ((refreshed.meta?.changes ?? 0) !== 1) {
    const current = await firstD1<TrialClaimRow>(input.db.prepare(
      `SELECT id, fingerprint_hash, features_json, claimed_at,
              expires_at, last_validated_at, revoked_at, revoke_reason
       FROM trial_claims
       WHERE instance_id = ?1 AND product_id = ?2 AND id = ?3 LIMIT 1`
    ).bind(input.instanceId, input.productId, input.trialId));
    if (!current) throw new NotFoundError("Trial Claim not found");
    if (current.revoked_at) {
      throw new AppError("TRIAL_REVOKED", "The Trial Claim has been revoked.", 403, {
        trial_id: current.id,
        revoked_at: current.revoked_at,
        revoke_reason: current.revoke_reason,
      });
    }
    if (now.getTime() >= Date.parse(current.expires_at)) {
      throw new AppError("TRIAL_EXPIRED", "The Trial Claim has expired.", 403, {
        trial_id: current.id,
        expires_at: current.expires_at,
      });
    }
    throw new AppError("TRIAL_STATE_CHANGED", "The Trial Claim changed during online validation.", 409);
  }
  const features = parseFeatures(claim.features_json);
  return {
    trial_id: claim.id,
    status: "active" as const,
    expires_at: claim.expires_at,
    features,
    validated_at: now.toISOString(),
    state: {
      kind: "trial" as const,
      status: "active" as const,
      expires_at: claim.expires_at,
      features,
    },
    validation: createServerValidationMetadata({
      validatedAt: now,
      validationIntervalSeconds: claim.validation_interval_seconds,
      offlineGraceSeconds: null,
    }),
  };
}
