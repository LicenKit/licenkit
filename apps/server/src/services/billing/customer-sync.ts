import { ulid } from "ulid";
import { fetchPaddleCustomer } from "../../infra/billing/paddle";
import type { BillingProviderRecord } from "../../infra/billing/types";
import { BillingProcessingError, PaddleHttpError } from "../../infra/billing/errors";
import { recordProviderSystemIssue } from "./system-issues";

export type BillingCustomerSyncSource = "webhook" | "api" | "reconciliation";

export interface TrustedBillingCustomerSnapshot {
  externalCustomerId: string;
  email: string;
  name: string | null;
  status: "active" | "archived";
  externalUpdatedAt: string;
  externalEventId: string | null;
}

interface BillingCustomerRow {
  id: string;
  instance_id: string;
  billing_provider_id: string;
  customer_id: string | null;
  external_customer_id: string;
  provider_email: string;
  provider_status: "active" | "archived";
  link_status: "pending" | "linked" | "email_mismatch" | "needs_attention";
  external_updated_at: string;
}

export function normalizeCustomerEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new BillingProcessingError(
      "BILLING_CUSTOMER_EMAIL_INVALID",
      "Provider Customer email is invalid.",
      "needs_attention",
      { providerEmailPresent: Boolean(email) },
    );
  }
  return normalized;
}

export async function getBillingProvider(
  db: D1Database,
  instanceId: string,
  billingProviderId: string,
): Promise<BillingProviderRecord | null> {
  const row = await db.prepare(
    `SELECT id, instance_id, provider, environment, client_side_token,
            webhook_secret_ciphertext, webhook_secret_version,
            api_secret_ciphertext, status, created_at, updated_at
     FROM billing_providers
     WHERE instance_id = ?1 AND id = ?2
     LIMIT 1`,
  ).bind(instanceId, billingProviderId).first<BillingProviderRecord>();
  return row ?? null;
}

export async function getBillingCustomerByExternalId(
  db: D1Database,
  instanceId: string,
  billingProviderId: string,
  externalCustomerId: string,
): Promise<BillingCustomerRow | null> {
  const row = await db.prepare(
    `SELECT id, instance_id, billing_provider_id, customer_id, external_customer_id,
            provider_email, provider_status, link_status, external_updated_at
     FROM billing_customers
     WHERE instance_id = ?1 AND billing_provider_id = ?2 AND external_customer_id = ?3
     LIMIT 1`,
  ).bind(instanceId, billingProviderId, externalCustomerId).first<BillingCustomerRow>();
  return row ?? null;
}

export async function syncTrustedBillingCustomer(input: {
  db: D1Database;
  instanceId: string;
  billingProviderId: string;
  snapshot: TrustedBillingCustomerSnapshot;
  source: BillingCustomerSyncSource;
  now?: Date;
}): Promise<BillingCustomerRow & { ignoredAsStale: boolean }> {
  const { db, instanceId, billingProviderId, snapshot, source } = input;
  const now = (input.now ?? new Date()).toISOString();
  const email = normalizeCustomerEmail(snapshot.email);
  const current = await getBillingCustomerByExternalId(
    db,
    instanceId,
    billingProviderId,
    snapshot.externalCustomerId,
  );
  if (current && current.external_updated_at >= snapshot.externalUpdatedAt) {
    return { ...current, ignoredAsStale: true };
  }

  if (current?.customer_id) {
    const customer = await db.prepare(
      `SELECT email, status FROM customers
       WHERE instance_id = ?1 AND id = ?2
       LIMIT 1`,
    ).bind(instanceId, current.customer_id).first<{ email: string; status: "active" | "disabled" }>();
    if (!customer) {
      throw new BillingProcessingError(
        "BILLING_CUSTOMER_LINK_BROKEN",
        "Billing Customer references a missing LicenKit Customer.",
        "needs_attention",
        { billingCustomerId: current.id, externalCustomerId: snapshot.externalCustomerId },
      );
    }
    const linkStatus = customer.status === "active" && customer.email.toLowerCase() === email
      ? "linked"
      : "email_mismatch";
    await db.prepare(
      `UPDATE billing_customers
       SET provider_email = ?1, provider_name = ?2, provider_status = ?3,
           link_status = ?4, last_sync_source = ?5, external_updated_at = ?6,
           last_external_event_id = ?7, updated_at = ?8
       WHERE instance_id = ?9 AND billing_provider_id = ?10 AND external_customer_id = ?11`,
    ).bind(
      email,
      snapshot.name,
      snapshot.status,
      linkStatus,
      source,
      snapshot.externalUpdatedAt,
      snapshot.externalEventId,
      now,
      instanceId,
      billingProviderId,
      snapshot.externalCustomerId,
    ).run();
    return {
      ...current,
      provider_email: email,
      provider_status: snapshot.status,
      link_status: linkStatus,
      external_updated_at: snapshot.externalUpdatedAt,
      ignoredAsStale: false,
    };
  }

  const billingCustomerId = current?.id ?? `bcu_${ulid().toLowerCase()}`;
  if (snapshot.status === "archived") {
    if (current) {
      await db.prepare(
        `UPDATE billing_customers
         SET provider_email = ?1, provider_name = ?2, provider_status = 'archived',
             link_status = 'needs_attention', last_sync_source = ?3,
             external_updated_at = ?4, last_external_event_id = ?5, updated_at = ?6
         WHERE instance_id = ?7 AND id = ?8`,
      ).bind(email, snapshot.name, source, snapshot.externalUpdatedAt, snapshot.externalEventId,
        now, instanceId, current.id).run();
    } else {
      await db.prepare(
        `INSERT INTO billing_customers (
           id, instance_id, billing_provider_id, customer_id, external_customer_id,
           provider_email, provider_name, provider_status, link_status,
           last_sync_source, external_updated_at, last_external_event_id, created_at, updated_at
         ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, 'archived', 'needs_attention', ?7, ?8, ?9, ?10, ?10)`,
      ).bind(billingCustomerId, instanceId, billingProviderId, snapshot.externalCustomerId,
        email, snapshot.name, source, snapshot.externalUpdatedAt, snapshot.externalEventId, now).run();
    }
    const row = await getBillingCustomerByExternalId(db, instanceId, billingProviderId, snapshot.externalCustomerId);
    if (!row) throw new Error("Billing Customer insert did not persist.");
    return { ...row, ignoredAsStale: false };
  }

  const newCustomerId = `cus_${ulid().toLowerCase()}`;
  const customerInsert = db.prepare(
    `INSERT INTO customers (id, instance_id, email, name, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)
     ON CONFLICT(instance_id, email) DO NOTHING`,
  ).bind(newCustomerId, instanceId, email, snapshot.name, now);
  const billingInsertOrUpdate = current
    ? db.prepare(
        `UPDATE billing_customers
         SET customer_id = (SELECT id FROM customers WHERE instance_id = ?1 AND email = ?2 LIMIT 1),
             provider_email = ?2, provider_name = ?3, provider_status = 'active',
             link_status = 'linked', last_sync_source = ?4, external_updated_at = ?5,
             last_external_event_id = ?6, updated_at = ?7
         WHERE instance_id = ?1 AND id = ?8 AND customer_id IS NULL`,
      ).bind(instanceId, email, snapshot.name, source, snapshot.externalUpdatedAt,
        snapshot.externalEventId, now, current.id)
    : db.prepare(
        `INSERT INTO billing_customers (
           id, instance_id, billing_provider_id, customer_id, external_customer_id,
           provider_email, provider_name, provider_status, link_status,
           last_sync_source, external_updated_at, last_external_event_id, created_at, updated_at
         ) SELECT ?1, ?2, ?3, customer.id, ?4, ?5, ?6, 'active', 'linked', ?7, ?8, ?9, ?10, ?10
           FROM customers AS customer
          WHERE customer.instance_id = ?2 AND customer.email = ?5
          LIMIT 1`,
      ).bind(billingCustomerId, instanceId, billingProviderId, snapshot.externalCustomerId,
        email, snapshot.name, source, snapshot.externalUpdatedAt, snapshot.externalEventId, now);

  try {
    await db.batch([customerInsert, billingInsertOrUpdate]);
  } catch (error) {
    // Another event may have linked the same external Customer concurrently.
    // Re-read by the unique provider identity; never scan or guess by payload.
    const raced = await getBillingCustomerByExternalId(db, instanceId, billingProviderId, snapshot.externalCustomerId);
    if (raced) return { ...raced, ignoredAsStale: false };
    throw error;
  }
  const linked = await getBillingCustomerByExternalId(db, instanceId, billingProviderId, snapshot.externalCustomerId);
  if (!linked) {
    throw new BillingProcessingError(
      "BILLING_CUSTOMER_LINK_FAILED",
      "Billing Customer could not be linked to a LicenKit Customer.",
      "retry",
      { externalCustomerId: snapshot.externalCustomerId },
    );
  }
  return { ...linked, ignoredAsStale: false };
}

export async function reconcileBillingCustomer(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string; STORAGE_ENCRYPTION_KEY_ID?: string };
  instanceId: string;
  billingCustomerId: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<Record<string, unknown>> {
  const current = await input.db.prepare(
    `SELECT id, billing_provider_id, external_customer_id
     FROM billing_customers
     WHERE instance_id = ?1 AND id = ?2
     LIMIT 1`,
  ).bind(input.instanceId, input.billingCustomerId).first<{
    id: string; billing_provider_id: string; external_customer_id: string;
  }>();
  if (!current) {
    throw new BillingProcessingError("BILLING_CUSTOMER_NOT_FOUND", "Billing Customer was not found.", "failed", {
      billingCustomerId: input.billingCustomerId,
    });
  }
  const provider = await getBillingProvider(input.db, input.instanceId, current.billing_provider_id);
  if (!provider) {
    throw new BillingProcessingError("BILLING_PROVIDER_NOT_FOUND", "Billing Provider was not found.", "failed", {
      billingProviderId: current.billing_provider_id,
    });
  }
  if (!provider.api_secret_ciphertext) {
    throw new BillingProcessingError(
      "BILLING_PROVIDER_API_CAPABILITY_DISABLED",
      "Paddle API reconciliation is not configured for this Provider.",
      "failed",
      { billingProviderId: provider.id, capability: "customer.read" },
    );
  }
  const now = input.now ?? new Date();
  let snapshot;
  try {
    snapshot = await fetchPaddleCustomer(
      provider,
      current.external_customer_id,
      input.env,
      input.fetchImpl,
    );
  } catch (error) {
    if (error instanceof PaddleHttpError && error.code === "BILLING_PROVIDER_API_AUTH_INVALID") {
      await recordProviderSystemIssue({
        db: input.db,
        instanceId: input.instanceId,
        billingProviderId: provider.id,
        capability: "customer_read",
        issueCode: error.code,
        providerError: error.providerDetails,
        now,
      });
    }
    throw error;
  }
  const synced = await syncTrustedBillingCustomer({
    db: input.db,
    instanceId: input.instanceId,
    billingProviderId: provider.id,
    source: "reconciliation",
    now,
    snapshot: {
      externalCustomerId: snapshot.id,
      email: snapshot.email,
      name: snapshot.name,
      status: snapshot.status,
      externalUpdatedAt: snapshot.updatedAt ?? snapshot.createdAt,
      externalEventId: null,
    },
  });
  return {
    id: synced.id,
    externalCustomerId: synced.external_customer_id,
    linkStatus: synced.link_status,
    ignoredAsStale: synced.ignoredAsStale,
    providerRequestId: snapshot.requestId,
  };
}
