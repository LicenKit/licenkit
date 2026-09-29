import { ulid } from "ulid";
import { AppError, NotFoundError } from "../../middleware/error";
import { generateLicenseKey, hashLicenseKey } from "../../infra/crypto";
import { normalizeCustomerEmail } from "../../domain/license/credentials";
import { resolveManualTerms, type LicensePlanSnapshot } from "../../domain/license/terms";
import { prepareEmailNotificationDelivery } from "../delivery/outbox";
import { prepareLicenseAudit, type LicenseActor } from "./audit";
import { firstD1 } from "./d1";

interface ManualPlanRow {
  id: string;
  product_id: string;
  product_name: string;
  revision: number;
  license_model: LicensePlanSnapshot["licenseModel"];
  credential_mode: LicensePlanSnapshot["credentialMode"];
  default_term_seconds: number | null;
  update_window_seconds: number | null;
  offline_grace_seconds: number;
  payment_grace_seconds: number;
  max_activations: number;
  features_json: string;
  plan_status: string;
  product_status: string;
  has_active_signing_key: number;
}

interface CustomerRow {
  id: string;
  status: string;
}

export async function issueManualLicense(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string; SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS?: string | number };
  instanceId: string;
  licensePlanId: string;
  customerEmail: string;
  expiresAt?: string | null;
  actor: LicenseActor;
  requestId?: string;
  ip?: string;
  userAgent?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const email = normalizeCustomerEmail(input.customerEmail);
  const plan = await firstD1<ManualPlanRow>(input.db.prepare(
    `SELECT
       lp.id, lp.product_id, p.name AS product_name, lp.revision,
       lp.license_model, lp.credential_mode, lp.default_term_seconds,
       lp.update_window_seconds, lp.offline_grace_seconds,
       lp.payment_grace_seconds, lp.max_activations, lp.features_json,
       lp.status AS plan_status, p.status AS product_status,
       EXISTS (
         SELECT 1 FROM signing_keys sk
         WHERE sk.instance_id = lp.instance_id
           AND sk.product_id = lp.product_id
           AND sk.status = 'active'
       ) AS has_active_signing_key
     FROM license_plans lp
     JOIN products p ON p.instance_id = lp.instance_id AND p.id = lp.product_id
     WHERE lp.instance_id = ?1 AND lp.id = ?2
     LIMIT 1`
  ).bind(input.instanceId, input.licensePlanId));
  if (!plan) throw new NotFoundError("License Plan not found");
  if (plan.plan_status !== "active") {
    throw new AppError("LICENSE_PLAN_ARCHIVED", "An archived License Plan cannot issue new Licenses.", 409);
  }
  if (plan.product_status !== "active") {
    throw new AppError("PRODUCT_ARCHIVED", "An archived Product cannot issue new Licenses.", 409);
  }
  if (plan.credential_mode === "signed" && !plan.has_active_signing_key) {
    throw new AppError(
      "SIGNING_KEY_NOT_CONFIGURED",
      "No active signing key is available for this Product.",
      409,
      { product_id: plan.product_id },
    );
  }

  const terms = resolveManualTerms({
    id: plan.id,
    revision: plan.revision,
    licenseModel: plan.license_model,
    credentialMode: plan.credential_mode,
    defaultTermSeconds: plan.default_term_seconds,
    updateWindowSeconds: plan.update_window_seconds,
    offlineGraceSeconds: plan.offline_grace_seconds,
    paymentGraceSeconds: plan.payment_grace_seconds,
    maxActivations: plan.max_activations,
    featuresJson: plan.features_json,
  }, now, input.expiresAt);

  let customer = await firstD1<CustomerRow>(input.db.prepare(
    `SELECT id, status FROM customers WHERE instance_id = ?1 AND email = ?2 COLLATE NOCASE LIMIT 1`
  ).bind(input.instanceId, email));
  if (customer?.status === "disabled") {
    throw new AppError("CUSTOMER_DISABLED", "A License cannot be issued to a disabled Customer.", 409);
  }

  const customerId = customer?.id ?? `cus_${ulid().toLowerCase()}`;
  const licenseId = `lic_${ulid().toLowerCase()}`;
  const licenseKey = generateLicenseKey("LK");
  const keyHash = await hashLicenseKey(licenseKey);
  const delivery = await prepareEmailNotificationDelivery({
    db: input.db,
    env: input.env,
    instanceId: input.instanceId,
    customerId,
    notificationType: "customer.license_issued",
    contractVersion: 1,
    recipientEmail: email,
    variables: {
      product_id: plan.product_id,
      product_name: plan.product_name,
      license_id: licenseId,
      license_key: licenseKey,
      license_model: terms.licenseModel,
      ...(terms.expiresAt ? { expires_at: terms.expiresAt } : {}),
      ...(terms.updatesUntil ? { updates_until: terms.updatesUntil } : {}),
    },
    now,
  });

  const statements: D1PreparedStatement[] = [];
  if (!customer) {
    statements.push(input.db.prepare(
      `INSERT INTO customers (id, instance_id, email, name, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, 'active', ?4, ?4)`
    ).bind(customerId, input.instanceId, email, nowIso));
  }
  statements.push(input.db.prepare(
    `INSERT INTO licenses (
       id, instance_id, customer_id, product_id, plan_id, plan_revision,
       license_model, renewal_mode, credential_mode, offline_grace_seconds,
       payment_grace_seconds, max_activations, features_json, key_hash,
       key_version, key_rotated_at, source, source_billing_provider_id,
       source_external_transaction_id, is_checkout_verification, status,
       status_reason, expires_at, updates_until, suspended_at, revoked_at,
       created_at, updated_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
       1, NULL, 'manual', NULL, NULL, 0, 'active', NULL, ?15, ?16, NULL, NULL,
       ?17, ?17
     )`
  ).bind(
    licenseId,
    input.instanceId,
    customerId,
    plan.product_id,
    terms.planId,
    terms.planRevision,
    terms.licenseModel,
    terms.renewalMode,
    terms.credentialMode,
    terms.offlineGraceSeconds,
    terms.paymentGraceSeconds,
    terms.maxActivations,
    terms.featuresJson,
    keyHash,
    terms.expiresAt,
    terms.updatesUntil,
    nowIso,
  ));
  statements.push(...delivery.statements);
  statements.push(prepareLicenseAudit({
    db: input.db,
    instanceId: input.instanceId,
    actor: input.actor,
    action: "license.issue_manual",
    resourceType: "license",
    resourceId: licenseId,
    requestId: input.requestId,
    details: {
      customerId,
      productId: plan.product_id,
      licensePlanId: plan.id,
      planRevision: plan.revision,
      licenseModel: terms.licenseModel,
      renewalMode: terms.renewalMode,
      expiresAt: terms.expiresAt,
      updatesUntil: terms.updatesUntil,
      deliveryId: delivery.deliveryId,
      deliveryStatus: delivery.status,
    },
    ip: input.ip,
    userAgent: input.userAgent,
    now,
  }));

  try {
    await input.db.batch(statements);
  } catch (error) {
    if (String(error).includes("LICENSE_MANUAL_ISSUE_INVARIANT")) {
      throw new AppError(
        "LICENSE_MANUAL_ISSUE_STATE_CHANGED",
        "The Product, License Plan, Customer, or signing-key state changed before issuance completed.",
        409,
      );
    }
    throw error;
  }
  return {
    license: {
      id: licenseId,
      customerId,
      productId: plan.product_id,
      licensePlanId: plan.id,
      licenseKey,
      status: "active" as const,
      licenseModel: terms.licenseModel,
      renewalMode: terms.renewalMode,
      credentialMode: terms.credentialMode,
      billingEnvironment: "live" as const,
      expiresAt: terms.expiresAt,
      updatesUntil: terms.updatesUntil,
      paymentGraceSeconds: terms.paymentGraceSeconds,
      maxActivations: terms.maxActivations,
      features: JSON.parse(terms.featuresJson) as string[],
      keyVersion: 1,
      createdAt: nowIso,
    },
    delivery: { id: delivery.deliveryId, status: delivery.status },
  };
}
