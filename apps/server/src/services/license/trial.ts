import { ulid } from "ulid";
import { AppError, NotFoundError } from "../../middleware/error";
import { sha256Hex, timingSafeEqual } from "../../infra/crypto";
import {
  generateTrialToken,
  hashDeviceFingerprint,
  hashTrialToken,
} from "../../domain/license/credentials";
import { parseFeatures } from "../../domain/license/terms";
import { createServerValidationMetadata } from "../../domain/license/validation-policy";
import { firstD1 } from "./d1";

interface TrialProductRow {
  status: string;
  trial_enabled: number;
  trial_duration_seconds: number | null;
  trial_features_json: string;
}

interface TrialClaimRow {
  id: string;
  fingerprint_hash: string;
  trial_token_hash: string;
  features_json: string;
  claimed_at: string;
  expires_at: string;
  last_validated_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
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
    `SELECT status, trial_enabled, trial_duration_seconds, trial_features_json
     FROM products WHERE instance_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(input.instanceId, input.productId));
  if (!product) throw new NotFoundError("Product not found");
  if (product.status !== "active") throw new AppError("PRODUCT_UNAVAILABLE", "The Product is archived.", 409);
  if (!product.trial_enabled) throw new AppError("TRIAL_NOT_ENABLED", "This Product does not offer a device trial.", 404);
  if (!product.trial_duration_seconds || product.trial_duration_seconds <= 0) {
    throw new AppError("TRIAL_CONFIGURATION_INVALID", "The Product trial duration is invalid.", 500);
  }
  const fingerprintHash = await hashDeviceFingerprint(input.fingerprint);
  const existing = await firstD1<{ id: string }>(input.db.prepare(
    `SELECT id FROM trial_claims
     WHERE instance_id = ?1 AND product_id = ?2 AND fingerprint_hash = ?3 LIMIT 1`
  ).bind(input.instanceId, input.productId, fingerprintHash));
  if (existing) {
    throw new AppError("TRIAL_ALREADY_CLAIMED", "This device has already claimed the Product trial.", 409);
  }

  const features = parseFeatures(product.trial_features_json);
  const trialId = `trl_${ulid().toLowerCase()}`;
  const trialToken = generateTrialToken();
  const tokenHash = await hashTrialToken(trialToken);
  const expiresAt = new Date(now.getTime() + product.trial_duration_seconds * 1000).toISOString();
  try {
    await input.db.prepare(
      `INSERT INTO trial_claims (
         id, instance_id, product_id, fingerprint_hash, trial_token_hash,
         features_json, claimed_at, expires_at, last_validated_at,
         revoked_at, revoke_reason, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7, NULL, NULL, ?7)`
    ).bind(
      trialId,
      input.instanceId,
      input.productId,
      fingerprintHash,
      tokenHash,
      product.trial_features_json,
      now.toISOString(),
      expiresAt,
    ).run();
  } catch (error) {
    const raw = String(error);
    if (raw.includes("trial_claims.instance_id, trial_claims.product_id, trial_claims.fingerprint_hash")) {
      const concurrent = await firstD1<{ id: string }>(input.db.prepare(
        `SELECT id FROM trial_claims
         WHERE instance_id = ?1 AND product_id = ?2 AND fingerprint_hash = ?3 LIMIT 1`
      ).bind(input.instanceId, input.productId, fingerprintHash));
      throw new AppError(
        "TRIAL_ALREADY_CLAIMED",
        "This device has already claimed the Product trial.",
        409,
        undefined,
        { database_error: raw, concurrent_claim_found: Boolean(concurrent) },
      );
    }
    throw error;
  }
  return {
    trial_id: trialId,
    trial_token: trialToken,
    status: "active" as const,
    expires_at: expiresAt,
    features,
    state: {
      kind: "trial" as const,
      status: "active" as const,
      expires_at: expiresAt,
      features,
    },
    validation: createServerValidationMetadata(now),
  };
}

export async function validateTrial(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
  trialId: string;
  trialToken: string;
  fingerprint: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const claim = await firstD1<TrialClaimRow>(input.db.prepare(
    `SELECT id, fingerprint_hash, trial_token_hash, features_json, claimed_at,
            expires_at, last_validated_at, revoked_at, revoke_reason
     FROM trial_claims
     WHERE instance_id = ?1 AND product_id = ?2 AND id = ?3 LIMIT 1`
  ).bind(input.instanceId, input.productId, input.trialId));
  if (!claim) throw new NotFoundError("Trial Claim not found");
  const fingerprintHash = await hashDeviceFingerprint(input.fingerprint);
  const tokenHash = await sha256Hex(input.trialToken);
  if (
    !timingSafeEqual(fingerprintHash, claim.fingerprint_hash) ||
    !timingSafeEqual(tokenHash, claim.trial_token_hash)
  ) {
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
      `SELECT id, fingerprint_hash, trial_token_hash, features_json, claimed_at,
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
    validation: createServerValidationMetadata(now),
  };
}
