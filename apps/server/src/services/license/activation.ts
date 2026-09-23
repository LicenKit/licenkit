import { ulid } from "ulid";
import { AppError, NotFoundError } from "../../middleware/error";
import { decryptEnvelopeV1 } from "../../infra/delivery/crypto";
import { hashLicenseKey, sha256Hex, timingSafeEqual } from "../../infra/crypto";
import { generateOpaqueMachineToken, hashDeviceFingerprint } from "../../domain/license/credentials";
import {
  createSignedLicenseToken,
  signedClaimInstant,
  signedTokenExpiration,
} from "../../domain/license/signed-token";
import { effectiveLicenseExpiresAt, parseFeatures } from "../../domain/license/terms";
import { createServerValidationMetadata } from "../../domain/license/validation-policy";
import { firstD1 } from "./d1";

interface ProductReleaseRow {
  id: string;
  version: string;
  platform: string;
  released_at: string;
}

interface LicenseRow {
  id: string;
  instance_id: string;
  product_id: string;
  license_model: "perpetual" | "fixed_term" | "subscription";
  renewal_mode: "none" | "manual" | "billing";
  credential_mode: "opaque" | "signed";
  signed_token_ttl_seconds: number;
  payment_grace_seconds: number;
  max_activations: number;
  features_json: string;
  is_checkout_verification: number;
  status: "active" | "suspended" | "revoked";
  status_reason: string | null;
  expires_at: string | null;
  updates_until: string | null;
  updated_at: string;
}

interface ActivationRow {
  id: string;
  license_id: string;
  fingerprint_hash: string;
  machine_token_hash: string;
  status: "active" | "deactivated" | "revoked";
}

interface SigningKeyRow {
  id: string;
  private_key_ciphertext: string;
}

export async function requireProductRelease(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
  version: string;
  platform: string;
}): Promise<ProductReleaseRow> {
  const release = await firstD1<ProductReleaseRow>(input.db.prepare(
    `SELECT id, version, platform, released_at
     FROM product_releases
     WHERE instance_id = ?1 AND product_id = ?2 AND version = ?3 AND platform = ?4
     LIMIT 1`
  ).bind(input.instanceId, input.productId, input.version, input.platform));
  if (!release) {
    throw new AppError(
      "PRODUCT_RELEASE_UNKNOWN",
      "The requested Product Release is not registered.",
      404,
      { release_version: input.version, release_platform: input.platform },
    );
  }
  return release;
}

function assertLicenseUsable(license: LicenseRow, now: Date) {
  if (license.is_checkout_verification) {
    throw new AppError(
      "LICENSE_CHECKOUT_VERIFICATION_ONLY",
      "This key belongs to a Checkout Verification and cannot activate a customer device.",
      403,
      { license_id: license.id },
    );
  }
  if (license.status === "suspended") {
    throw new AppError("LICENSE_SUSPENDED", "The License is suspended.", 403, {
      license_id: license.id,
      status_reason: license.status_reason,
    });
  }
  if (license.status === "revoked") {
    throw new AppError("LICENSE_REVOKED", "The License is revoked.", 403, {
      license_id: license.id,
      status_reason: license.status_reason,
    });
  }
  const calculatedExpiresAt = effectiveLicenseExpiresAt({
    renewalMode: license.renewal_mode,
    expiresAt: license.expires_at,
    paymentGraceSeconds: license.payment_grace_seconds,
  });
  const effectiveExpiresAt = calculatedExpiresAt && license.credential_mode === "signed"
    ? signedClaimInstant(calculatedExpiresAt).toISOString()
    : calculatedExpiresAt;
  if (effectiveExpiresAt) {
    if (now.getTime() >= Date.parse(effectiveExpiresAt)) {
      throw new AppError("LICENSE_EXPIRED", "The License term has expired.", 403, {
        license_id: license.id,
        expires_at: effectiveExpiresAt,
        billing_period_expires_at: license.expires_at,
        payment_grace_seconds: license.renewal_mode === "billing" ? license.payment_grace_seconds : 0,
      });
    }
  }
}

function assertReleaseEntitlement(license: LicenseRow, release: ProductReleaseRow) {
  const updatesUntil = license.updates_until && license.credential_mode === "signed"
    ? signedClaimInstant(license.updates_until).toISOString()
    : license.updates_until;
  const releasedAt = license.credential_mode === "signed"
    ? signedClaimInstant(release.released_at).toISOString()
    : release.released_at;
  if (
    license.license_model === "perpetual" &&
    updatesUntil &&
    Date.parse(releasedAt) > Date.parse(updatesUntil)
  ) {
    throw new AppError(
      "UPDATE_ENTITLEMENT_REQUIRED",
      "This Product Release was published after the License update entitlement ended.",
      403,
      {
        license_id: license.id,
        updates_until: updatesUntil,
        release_version: release.version,
        release_platform: release.platform,
        released_at: releasedAt,
      },
    );
  }
}

async function createCredentialResponse(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string };
  license: LicenseRow;
  activationId: string;
  machineToken: string;
  fingerprint: string;
  release: ProductReleaseRow;
  now: Date;
}) {
  const features = parseFeatures(input.license.features_json);
  const calculatedExpiresAt = effectiveLicenseExpiresAt({
    renewalMode: input.license.renewal_mode,
    expiresAt: input.license.expires_at,
    paymentGraceSeconds: input.license.payment_grace_seconds,
  });
  const effectiveExpiresAt = calculatedExpiresAt && input.license.credential_mode === "signed"
    ? signedClaimInstant(calculatedExpiresAt).toISOString()
    : calculatedExpiresAt;
  const updatesUntil = input.license.updates_until && input.license.credential_mode === "signed"
    ? signedClaimInstant(input.license.updates_until).toISOString()
    : input.license.updates_until;
  const base = {
    activation_id: input.activationId,
    machine_token: input.machineToken,
    credential_mode: input.license.credential_mode,
    signed_license_token: null as string | null,
    signed_license_token_expires_at: null as string | null,
    signing_key_id: null as string | null,
    license_expires_at: effectiveExpiresAt,
    terms: {
      license_model: input.license.license_model,
      renewal_mode: input.license.renewal_mode,
      max_activations: input.license.max_activations,
      features,
      updates_until: updatesUntil,
    },
  };
  if (input.license.credential_mode === "opaque") return base;

  const signingKey = await firstD1<SigningKeyRow>(input.db.prepare(
    `SELECT id, private_key_ciphertext FROM signing_keys
     WHERE instance_id = ?1 AND product_id = ?2 AND status = 'active'
     LIMIT 1`
  ).bind(input.license.instance_id, input.license.product_id));
  if (!signingKey) {
    throw new AppError("SIGNING_KEY_NOT_CONFIGURED", "No active signing key is available for this Product.", 500, {
      product_id: input.license.product_id,
    });
  }
  const privateKey = await decryptEnvelopeV1(signingKey.private_key_ciphertext, input.env, {
    instanceId: input.license.instance_id,
    table: "signing_keys",
    rowId: signingKey.id,
    field: "private_key_ciphertext",
  });
  const tokenExpiry = signedTokenExpiration({
    issuedAt: input.now,
    ttlSeconds: input.license.signed_token_ttl_seconds,
    licenseExpiresAt: effectiveExpiresAt,
  });
  base.signed_license_token = await createSignedLicenseToken({
    keyId: signingKey.id,
    privateKeyPkcs8: privateKey,
    claims: {
      lic: input.license.id,
      act: input.activationId,
      ins: input.license.instance_id,
      prd: input.license.product_id,
      rel: input.release.id,
      ver: input.release.version,
      plt: input.release.platform,
      rat: Math.floor(Date.parse(input.release.released_at) / 1000),
      fp: input.fingerprint,
      iat: Math.floor(input.now.getTime() / 1000),
      exp: Math.floor(tokenExpiry.getTime() / 1000),
      lexp: effectiveExpiresAt ? Math.floor(Date.parse(effectiveExpiresAt) / 1000) : null,
      upd: updatesUntil ? Math.floor(Date.parse(updatesUntil) / 1000) : null,
      fea: features,
    },
  });
  base.signed_license_token_expires_at = tokenExpiry.toISOString();
  base.signing_key_id = signingKey.id;
  return base;
}

export async function activateLicense(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string };
  instanceId: string;
  productId: string;
  licenseKey: string;
  fingerprint: string;
  devicePlatform?: string | null;
  name?: string | null;
  releaseVersion: string;
  releasePlatform: string;
  firstIp?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const keyHash = await hashLicenseKey(input.licenseKey);
  const license = await firstD1<LicenseRow>(input.db.prepare(
    `SELECT id, instance_id, product_id, license_model, renewal_mode,
            credential_mode, signed_token_ttl_seconds, payment_grace_seconds,
            max_activations, features_json, is_checkout_verification, status,
            status_reason, expires_at, updates_until, updated_at
     FROM licenses
     WHERE instance_id = ?1 AND product_id = ?2 AND key_hash = ?3
     LIMIT 1`
  ).bind(input.instanceId, input.productId, keyHash));
  if (!license) throw new AppError("LICENSE_KEY_INVALID", "The License Key is invalid.", 404);
  assertLicenseUsable(license, now);
  const release = await requireProductRelease({
    db: input.db,
    instanceId: input.instanceId,
    productId: input.productId,
    version: input.releaseVersion,
    platform: input.releasePlatform,
  });
  assertReleaseEntitlement(license, release);

  const fingerprintHash = await hashDeviceFingerprint(input.fingerprint);
  const machineToken = generateOpaqueMachineToken();
  const machineTokenHash = await sha256Hex(machineToken);
  let activation = await firstD1<ActivationRow>(input.db.prepare(
    `SELECT id, license_id, fingerprint_hash, machine_token_hash, status
     FROM activations
     WHERE instance_id = ?1 AND license_id = ?2 AND fingerprint_hash = ?3 AND status = 'active'
     LIMIT 1`
  ).bind(input.instanceId, license.id, fingerprintHash));

  let credentialResponse: Awaited<ReturnType<typeof createCredentialResponse>>;
  if (activation) {
    credentialResponse = await createCredentialResponse({
      db: input.db,
      env: input.env,
      license,
      activationId: activation.id,
      machineToken,
      fingerprint: input.fingerprint,
      release,
      now,
    });
    const refreshed = await input.db.prepare(
      `UPDATE activations
       SET machine_token_hash = ?1, name = COALESCE(?2, name),
           platform = COALESCE(?3, platform), last_validated_at = ?4, updated_at = ?4
       WHERE instance_id = ?5 AND license_id = ?6 AND id = ?7 AND status = 'active'
         AND EXISTS (
           SELECT 1 FROM licenses l
           WHERE l.instance_id = ?5 AND l.id = ?6 AND l.product_id = ?8
             AND l.updated_at = ?9
             AND l.is_checkout_verification = 0 AND l.status = 'active'
             AND (
               l.expires_at IS NULL
               OR datetime(l.expires_at, '+' || CASE WHEN l.renewal_mode = 'billing'
                    THEN l.payment_grace_seconds ELSE 0 END || ' seconds') > datetime(?4)
             )
         )`
    ).bind(
      machineTokenHash,
      input.name ?? null,
      input.devicePlatform ?? null,
      now.toISOString(),
      input.instanceId,
      license.id,
      activation.id,
      input.productId,
      license.updated_at,
    ).run();
    if ((refreshed.meta?.changes ?? 0) !== 1) {
      const current = await firstD1<LicenseRow>(input.db.prepare(
        `SELECT id, instance_id, product_id, license_model, renewal_mode,
                credential_mode, signed_token_ttl_seconds, payment_grace_seconds,
                max_activations, features_json, is_checkout_verification, status,
                status_reason, expires_at, updates_until, updated_at
         FROM licenses WHERE instance_id = ?1 AND id = ?2 LIMIT 1`
      ).bind(input.instanceId, license.id));
      if (!current) throw new NotFoundError("License not found");
      assertLicenseUsable(current, now);
      throw new AppError("ACTIVATION_CONFLICT", "The Activation changed concurrently.", 409);
    }
  } else {
    const activationId = `act_${ulid().toLowerCase()}`;
    credentialResponse = await createCredentialResponse({
      db: input.db,
      env: input.env,
      license,
      activationId,
      machineToken,
      fingerprint: input.fingerprint,
      release,
      now,
    });
    try {
      const inserted = await input.db.prepare(
        `INSERT INTO activations (
           id, instance_id, license_id, fingerprint_hash, machine_token_hash,
           name, platform, first_ip, status, activated_at, last_validated_at,
           deactivated_at, revoked_at, revoke_reason, updated_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?9, NULL, NULL, NULL, ?9
         FROM licenses l
         WHERE l.instance_id = ?2 AND l.id = ?3 AND l.product_id = ?10
           AND l.updated_at = ?11
           AND l.is_checkout_verification = 0 AND l.status = 'active'
           AND (
             l.expires_at IS NULL
             OR datetime(l.expires_at, '+' || CASE WHEN l.renewal_mode = 'billing'
                  THEN l.payment_grace_seconds ELSE 0 END || ' seconds') > datetime(?9)
           )`
      ).bind(
        activationId,
        input.instanceId,
        license.id,
        fingerprintHash,
        machineTokenHash,
        input.name ?? null,
        input.devicePlatform ?? null,
        input.firstIp ?? null,
        now.toISOString(),
        input.productId,
        license.updated_at,
      ).run();
      if ((inserted.meta?.changes ?? 0) !== 1) {
        const current = await firstD1<LicenseRow>(input.db.prepare(
          `SELECT id, instance_id, product_id, license_model, renewal_mode,
                  credential_mode, signed_token_ttl_seconds, payment_grace_seconds,
                  max_activations, features_json, is_checkout_verification, status,
                  status_reason, expires_at, updates_until, updated_at
           FROM licenses WHERE instance_id = ?1 AND id = ?2 LIMIT 1`
        ).bind(input.instanceId, license.id));
        if (!current) throw new NotFoundError("License not found");
        assertLicenseUsable(current, now);
        throw new AppError("LICENSE_STATE_CHANGED", "The License changed while activation was being created.", 409);
      }
      activation = {
        id: activationId,
        license_id: license.id,
        fingerprint_hash: fingerprintHash,
        machine_token_hash: machineTokenHash,
        status: "active",
      };
    } catch (error) {
      const raw = String(error);
      if (raw.includes("LICENSE_ACTIVATION_LIMIT_REACHED")) {
        const count = await firstD1<{ count: number }>(input.db.prepare(
          `SELECT COUNT(*) AS count FROM activations
           WHERE instance_id = ?1 AND license_id = ?2 AND status = 'active'`
        ).bind(input.instanceId, license.id));
        throw new AppError(
          "LICENSE_ACTIVATION_LIMIT_REACHED",
          "The License has reached its activation limit.",
          409,
          {
            license_id: license.id,
            active_activations: count?.count ?? license.max_activations,
            max_activations: license.max_activations,
            database_error: raw,
          },
          { database_error: raw },
        );
      }
      if (raw.includes("activations.instance_id, activations.license_id, activations.fingerprint_hash")) {
        activation = await firstD1<ActivationRow>(input.db.prepare(
          `SELECT id, license_id, fingerprint_hash, machine_token_hash, status
           FROM activations
           WHERE instance_id = ?1 AND license_id = ?2 AND fingerprint_hash = ?3 AND status = 'active'
           LIMIT 1`
        ).bind(input.instanceId, license.id, fingerprintHash));
        if (activation) {
          credentialResponse = await createCredentialResponse({
            db: input.db,
            env: input.env,
            license,
            activationId: activation.id,
            machineToken,
            fingerprint: input.fingerprint,
            release,
            now,
          });
          const refreshed = await input.db.prepare(
            `UPDATE activations SET machine_token_hash = ?1, last_validated_at = ?2, updated_at = ?2
             WHERE instance_id = ?3 AND license_id = ?4 AND id = ?5 AND status = 'active'
               AND EXISTS (
                 SELECT 1 FROM licenses l
                 WHERE l.instance_id = ?3 AND l.id = ?4 AND l.product_id = ?6
                   AND l.updated_at = ?7
                   AND l.is_checkout_verification = 0 AND l.status = 'active'
                   AND (
                     l.expires_at IS NULL
                     OR datetime(l.expires_at, '+' || CASE WHEN l.renewal_mode = 'billing'
                          THEN l.payment_grace_seconds ELSE 0 END || ' seconds') > datetime(?2)
                   )
               )`
          ).bind(
            machineTokenHash,
            now.toISOString(),
            input.instanceId,
            license.id,
            activation.id,
            input.productId,
            license.updated_at,
          ).run();
          if ((refreshed.meta?.changes ?? 0) !== 1) {
            const current = await firstD1<LicenseRow>(input.db.prepare(
              `SELECT id, instance_id, product_id, license_model, renewal_mode,
                      credential_mode, signed_token_ttl_seconds, payment_grace_seconds,
                      max_activations, features_json, is_checkout_verification, status,
                      status_reason, expires_at, updates_until, updated_at
               FROM licenses WHERE instance_id = ?1 AND id = ?2 LIMIT 1`
            ).bind(input.instanceId, license.id));
            if (!current) throw new NotFoundError("License not found");
            assertLicenseUsable(current, now);
            throw new AppError("ACTIVATION_CONFLICT", "The Activation changed concurrently.", 409);
          }
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  return {
    ...credentialResponse,
    state: {
      kind: "license" as const,
      status: "active" as const,
      expires_at: credentialResponse.license_expires_at,
      terms: credentialResponse.terms,
    },
    validation: createServerValidationMetadata(now),
  };
}

export async function validateActivation(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string };
  instanceId: string;
  productId: string;
  activationId: string;
  machineToken: string;
  fingerprint: string;
  releaseVersion: string;
  releasePlatform: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const fingerprintHash = await hashDeviceFingerprint(input.fingerprint);
  const activation = await firstD1<any>(input.db.prepare(
    `SELECT a.id, a.license_id, a.fingerprint_hash, a.machine_token_hash, a.status,
            l.instance_id, l.product_id, l.license_model, l.renewal_mode,
            l.credential_mode, l.signed_token_ttl_seconds, l.payment_grace_seconds,
            l.max_activations, l.features_json, l.is_checkout_verification,
            l.status AS license_status, l.status_reason, l.expires_at, l.updates_until,
            l.updated_at AS license_updated_at
     FROM activations a
     JOIN licenses l ON l.instance_id = a.instance_id AND l.id = a.license_id
     WHERE a.instance_id = ?1 AND l.product_id = ?2 AND a.id = ?3
     LIMIT 1`
  ).bind(input.instanceId, input.productId, input.activationId));
  if (!activation) throw new NotFoundError("Activation not found");
  const providedTokenHash = await sha256Hex(input.machineToken);
  if (
    !timingSafeEqual(providedTokenHash, activation.machine_token_hash) ||
    !timingSafeEqual(fingerprintHash, activation.fingerprint_hash)
  ) {
    throw new AppError("ACTIVATION_CREDENTIALS_INVALID", "The Activation credentials are invalid.", 401);
  }
  if (activation.status === "revoked") {
    throw new AppError("ACTIVATION_REVOKED", "The Activation is revoked.", 403, {
      activation_id: activation.id,
    });
  }
  if (activation.status === "deactivated") {
    throw new AppError("ACTIVATION_DEACTIVATED", "The Activation is deactivated.", 403, {
      activation_id: activation.id,
    });
  }
  const license: LicenseRow = {
    id: activation.license_id,
    instance_id: activation.instance_id,
    product_id: activation.product_id,
    license_model: activation.license_model,
    renewal_mode: activation.renewal_mode,
    credential_mode: activation.credential_mode,
    signed_token_ttl_seconds: activation.signed_token_ttl_seconds,
    payment_grace_seconds: activation.payment_grace_seconds,
    max_activations: activation.max_activations,
    features_json: activation.features_json,
    is_checkout_verification: activation.is_checkout_verification,
    status: activation.license_status,
    status_reason: activation.status_reason,
    expires_at: activation.expires_at,
    updates_until: activation.updates_until,
    updated_at: activation.license_updated_at,
  };
  assertLicenseUsable(license, now);
  const release = await requireProductRelease({
    db: input.db,
    instanceId: input.instanceId,
    productId: input.productId,
    version: input.releaseVersion,
    platform: input.releasePlatform,
  });
  assertReleaseEntitlement(license, release);
  const credentialResponse = await createCredentialResponse({
    db: input.db,
    env: input.env,
    license,
    activationId: input.activationId,
    machineToken: input.machineToken,
    fingerprint: input.fingerprint,
    release,
    now,
  });
  const refreshed = await input.db.prepare(
    `UPDATE activations SET last_validated_at = ?1, updated_at = ?1
     WHERE instance_id = ?2 AND license_id = ?3 AND id = ?4 AND status = 'active'
       AND EXISTS (
         SELECT 1 FROM licenses l
         WHERE l.instance_id = ?2 AND l.id = ?3 AND l.product_id = ?5
           AND l.updated_at = ?6
           AND l.is_checkout_verification = 0 AND l.status = 'active'
           AND (
             l.expires_at IS NULL
             OR datetime(l.expires_at, '+' || CASE WHEN l.renewal_mode = 'billing'
                  THEN l.payment_grace_seconds ELSE 0 END || ' seconds') > datetime(?1)
           )
       )`
  ).bind(
    now.toISOString(),
    input.instanceId,
    license.id,
    input.activationId,
    input.productId,
    license.updated_at,
  ).run();
  if ((refreshed.meta?.changes ?? 0) !== 1) {
    const currentActivation = await firstD1<ActivationRow>(input.db.prepare(
      `SELECT id, license_id, fingerprint_hash, machine_token_hash, status
       FROM activations WHERE instance_id = ?1 AND license_id = ?2 AND id = ?3 LIMIT 1`
    ).bind(input.instanceId, license.id, input.activationId));
    if (!currentActivation) throw new NotFoundError("Activation not found");
    if (currentActivation.status === "revoked") {
      throw new AppError("ACTIVATION_REVOKED", "The Activation is revoked.", 403, {
        activation_id: currentActivation.id,
      });
    }
    if (currentActivation.status === "deactivated") {
      throw new AppError("ACTIVATION_DEACTIVATED", "The Activation is deactivated.", 403, {
        activation_id: currentActivation.id,
      });
    }
    const currentLicense = await firstD1<LicenseRow>(input.db.prepare(
      `SELECT id, instance_id, product_id, license_model, renewal_mode,
              credential_mode, signed_token_ttl_seconds, payment_grace_seconds,
              max_activations, features_json, is_checkout_verification, status,
              status_reason, expires_at, updates_until, updated_at
       FROM licenses WHERE instance_id = ?1 AND id = ?2 LIMIT 1`
    ).bind(input.instanceId, license.id));
    if (!currentLicense) throw new NotFoundError("License not found");
    assertLicenseUsable(currentLicense, now);
    throw new AppError("LICENSE_STATE_CHANGED", "The License changed during online validation.", 409);
  }
  return {
    ...credentialResponse,
    state: {
      kind: "license" as const,
      status: "active" as const,
      expires_at: credentialResponse.license_expires_at,
      terms: credentialResponse.terms,
    },
    validation: createServerValidationMetadata(now),
  };
}

export async function deactivateActivation(input: {
  db: D1Database;
  instanceId: string;
  productId: string;
  activationId: string;
  machineToken: string;
  fingerprint: string;
  now?: Date;
}) {
  const fingerprintHash = await hashDeviceFingerprint(input.fingerprint);
  const tokenHash = await sha256Hex(input.machineToken);
  const activation = await firstD1<ActivationRow>(input.db.prepare(
    `SELECT a.id, a.license_id, a.fingerprint_hash, a.machine_token_hash, a.status
     FROM activations a
     JOIN licenses l ON l.instance_id = a.instance_id AND l.id = a.license_id
     WHERE a.instance_id = ?1 AND l.product_id = ?2 AND a.id = ?3
     LIMIT 1`
  ).bind(input.instanceId, input.productId, input.activationId));
  if (!activation) throw new NotFoundError("Activation not found");
  if (!timingSafeEqual(tokenHash, activation.machine_token_hash) || !timingSafeEqual(fingerprintHash, activation.fingerprint_hash)) {
    throw new AppError("ACTIVATION_CREDENTIALS_INVALID", "The Activation credentials are invalid.", 401);
  }
  if (activation.status === "revoked") throw new AppError("ACTIVATION_REVOKED", "The Activation is revoked.", 403);
  if (activation.status === "active") {
    const now = (input.now ?? new Date()).toISOString();
    await input.db.prepare(
      `UPDATE activations SET status = 'deactivated', deactivated_at = ?1, updated_at = ?1
       WHERE instance_id = ?2 AND license_id = ?3 AND id = ?4 AND status = 'active'`
    ).bind(now, input.instanceId, activation.license_id, activation.id).run();
  }
  return { activation_id: activation.id, status: "deactivated" as const };
}
