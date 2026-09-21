import { ulid } from "ulid";
import { generateLicenseKey, hashLicenseKey } from "../../infra/crypto";
import { AppError, NotFoundError } from "../../middleware/error";
import { prepareEmailNotificationDelivery } from "../delivery/outbox";
import { prepareLicenseAudit, type LicenseActor } from "./audit";
import { firstD1 } from "./d1";

interface RotationLicenseRow {
  id: string;
  instance_id: string;
  customer_id: string;
  product_id: string;
  product_name: string;
  customer_email: string;
  license_model: string;
  expires_at: string | null;
  updates_until: string | null;
  key_version: number;
  is_checkout_verification: number;
}

export type LicenseKeyRotationReason = "recovery" | "security_reset";

export async function prepareLicenseKeyRotation(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string; SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS?: string | number };
  instanceId: string;
  licenseId: string;
  actor: LicenseActor;
  reason: LicenseKeyRotationReason;
  requestId?: string;
  ip?: string;
  userAgent?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const customerConstraint = input.actor.type === "customer" ? "AND l.customer_id = ?3" : "";
  const bindings = input.actor.type === "customer"
    ? [input.instanceId, input.licenseId, input.actor.id]
    : [input.instanceId, input.licenseId];
  const license = await firstD1<RotationLicenseRow>(input.db.prepare(
    `SELECT l.id, l.instance_id, l.customer_id, l.product_id, p.name AS product_name,
            c.email AS customer_email, l.license_model, l.expires_at, l.updates_until,
            l.key_version, l.is_checkout_verification
     FROM licenses l
     JOIN customers c ON c.instance_id = l.instance_id AND c.id = l.customer_id
     JOIN products p ON p.instance_id = l.instance_id AND p.id = l.product_id
     WHERE l.instance_id = ?1 AND l.id = ?2 ${customerConstraint}
     LIMIT 1`
  ).bind(...bindings));
  if (!license) throw new NotFoundError("License not found");
  if (license.is_checkout_verification) {
    throw new AppError(
      "LICENSE_CHECKOUT_VERIFICATION_ONLY",
      "A Checkout Verification License cannot be recovered or reset.",
      409,
    );
  }

  const licenseKey = generateLicenseKey("LK");
  const keyHash = await hashLicenseKey(licenseKey);
  const nextKeyVersion = license.key_version + 1;
  const rotationId = `lkr_${ulid().toLowerCase()}`;
  const securityReset = input.reason === "security_reset";
  const eventType = securityReset
    ? "customer.license_security_reset"
    : "customer.license_recovered";
  const delivery = await prepareEmailNotificationDelivery({
    db: input.db,
    env: input.env,
    instanceId: input.instanceId,
    customerId: license.customer_id,
    notificationType: eventType,
    contractVersion: 1,
    recipientEmail: license.customer_email,
    variables: {
      product_id: license.product_id,
      product_name: license.product_name,
      license_id: license.id,
      license_key: licenseKey,
      license_model: license.license_model,
      key_version: nextKeyVersion,
      ...(license.expires_at ? { expires_at: license.expires_at } : {}),
      ...(license.updates_until ? { updates_until: license.updates_until } : {}),
    },
    now,
  });

  const statements: D1PreparedStatement[] = [
    input.db.prepare(
      `UPDATE licenses
       SET key_hash = CASE WHEN key_version = ?1 THEN ?2 ELSE key_hash END,
           key_version = CASE WHEN key_version = ?1 THEN ?3 ELSE 0 END,
           key_rotated_at = ?4,
           updated_at = ?4
       WHERE instance_id = ?5 AND id = ?6`
    ).bind(license.key_version, keyHash, nextKeyVersion, nowIso, input.instanceId, license.id),
  ];
  if (securityReset) {
    statements.push(input.db.prepare(
      `UPDATE activations
       SET status = 'revoked', revoked_at = ?1, revoke_reason = 'security_reset', updated_at = ?1
       WHERE instance_id = ?2 AND license_id = ?3 AND status = 'active'`
    ).bind(nowIso, input.instanceId, license.id));
  }
  statements.push(...delivery.statements);
  statements.push(input.db.prepare(
    `INSERT INTO license_key_rotations (
       id, instance_id, license_id, from_version, to_version, reason,
       revoked_activations, initiated_by_user_id, initiated_by_customer_id,
       delivery_id, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
  ).bind(
    rotationId,
    input.instanceId,
    license.id,
    license.key_version,
    nextKeyVersion,
    input.reason,
    securityReset ? 1 : 0,
    input.actor.type === "user" ? input.actor.id : null,
    input.actor.type === "customer" ? input.actor.id : null,
    delivery.deliveryId,
    nowIso,
  ));
  statements.push(prepareLicenseAudit({
    db: input.db,
    instanceId: input.instanceId,
    actor: input.actor,
    action: securityReset ? "license.security_reset" : "license.recover_key",
    resourceType: "license",
    resourceId: license.id,
    requestId: input.requestId,
    details: {
      fromKeyVersion: license.key_version,
      toKeyVersion: nextKeyVersion,
      revokedActivations: securityReset,
      deliveryId: delivery.deliveryId,
      deliveryStatus: delivery.status,
    },
    ip: input.ip,
    userAgent: input.userAgent,
    now,
  }));

  return {
    licenseKey,
    license: {
      id: license.id,
      customerId: license.customer_id,
      keyVersion: nextKeyVersion,
    },
    delivery: { id: delivery.deliveryId, status: delivery.status },
    statements,
  };
}

export async function rotateLicenseKey(input: Parameters<typeof prepareLicenseKeyRotation>[0]) {
  const prepared = await prepareLicenseKeyRotation(input);
  let results: D1Result[];
  try {
    results = await input.db.batch(prepared.statements);
  } catch (error) {
    const raw = String(error);
    if (raw.includes("key_version") || raw.includes("ck_licenses_key_version")) {
      throw new AppError(
        "LICENSE_KEY_ROTATION_CONFLICT",
        "The License key changed concurrently. Retry using the current License state.",
        409,
        { database_error: raw },
        { database_error: raw },
      );
    }
    throw error;
  }
  const updateResult = await Promise.resolve(results[0] as D1Result | Promise<D1Result>);
  if ((updateResult.meta?.changes ?? 0) !== 1) {
    throw new AppError(
      "LICENSE_KEY_ROTATION_CONFLICT",
      "The License key changed concurrently. Retry using the current License state.",
      409,
    );
  }
  const { statements: _statements, ...result } = prepared;
  return result;
}
