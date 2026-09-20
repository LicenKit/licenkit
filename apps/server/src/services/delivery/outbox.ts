import { ulid } from "ulid";
import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../../infra/delivery/crypto";

export type DeliveryStatus = "pending" | "blocked_configuration";

export interface PrepareNotificationDeliveryInput {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string; SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS?: string | number };
  accountId: string;
  customerId?: string | null;
  licenseId?: string | null;
  eventType: string;
  recipientEmail: string;
  payload: Record<string, unknown>;
  payloadExpiresAt?: string;
  idempotencyKey?: string;
  now?: Date;
}

export interface PreparedNotificationDelivery {
  deliveryId: string;
  status: DeliveryStatus;
  payloadExpiresAt: string;
  statements: D1PreparedStatement[];
}

export interface PrepareEndpointTestDeliveryInput {
  db: D1Database;
  env: PrepareNotificationDeliveryInput["env"];
  accountId: string;
  endpointId: string;
  now?: Date;
}

export interface ValidateNotificationDeliveryConfigurationInput {
  db: D1Database;
  env: PrepareNotificationDeliveryInput["env"];
  accountId: string;
  eventType: string;
}

interface NotificationEndpointRow {
  id: string;
  url: string;
  signing_secret_ciphertext: string;
  max_automatic_attempts: number;
}

const DEFAULT_SENSITIVE_PAYLOAD_TTL_SECONDS = 86_400;

function readPositiveInteger(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS must be a positive integer");
  }
  return parsed;
}

async function findNotificationEndpoint(
  db: D1Database,
  accountId: string,
  eventType: string,
): Promise<NotificationEndpointRow | undefined> {
  const endpointResult = await db
    .prepare(
      `SELECT id, url, signing_secret_ciphertext, max_automatic_attempts
       FROM outbound_endpoints
       WHERE account_id = ?1
         AND endpoint_type = 'notification_gateway'
         AND status = 'active'
         AND EXISTS (
           SELECT 1 FROM json_each(subscribed_events_json)
           WHERE value = ?2 OR value = '*'
         )
         AND EXISTS (
           SELECT 1 FROM outbound_deliveries AS endpoint_test
           WHERE endpoint_test.account_id = outbound_endpoints.account_id
             AND endpoint_test.endpoint_id = outbound_endpoints.id
             AND endpoint_test.event_type = 'endpoint.test'
             AND endpoint_test.status = 'accepted'
             AND endpoint_test.accepted_at >= outbound_endpoints.updated_at
         )
       LIMIT 1`,
    )
    .bind(accountId, eventType)
    .all<NotificationEndpointRow>();
  return endpointResult.results[0];
}

/**
 * Validates shared Notification Gateway crypto before a caller branches on a
 * private recipient identity. Missing/unverified endpoints are valid here:
 * the resulting Delivery is persisted as blocked_configuration instead.
 */
export async function validateNotificationDeliveryConfiguration(
  input: ValidateNotificationDeliveryConfigurationInput,
): Promise<void> {
  const endpoint = await findNotificationEndpoint(input.db, input.accountId, input.eventType);
  if (!endpoint) return;
  await decryptEnvelopeV1(endpoint.signing_secret_ciphertext, input.env, {
    accountId: input.accountId,
    table: "outbound_endpoints",
    rowId: endpoint.id,
    field: "signing_secret_ciphertext",
  });
}

/**
 * Builds the Delivery INSERT without executing it so callers can include it in
 * the same D1 batch as the domain mutation that produced the notification.
 */
export async function prepareNotificationDelivery(
  input: PrepareNotificationDeliveryInput
): Promise<PreparedNotificationDelivery> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const deliveryId = `dly_${ulid().toLowerCase()}`;
  const idempotencyKey = input.idempotencyKey ?? `${input.eventType}:${deliveryId}`;
  const payloadExpiresAt = input.payloadExpiresAt ?? new Date(
    now.getTime() + readPositiveInteger(
      input.env.SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS,
      DEFAULT_SENSITIVE_PAYLOAD_TTL_SECONDS,
    ) * 1000,
  ).toISOString();
  if (Date.parse(payloadExpiresAt) <= now.getTime()) {
    throw new Error("Delivery payload expiration must be in the future");
  }

  const endpoint = await findNotificationEndpoint(input.db, input.accountId, input.eventType);

  const body = JSON.stringify({
    id: deliveryId,
    type: input.eventType,
    created_at: nowIso,
    recipient: { email: input.recipientEmail },
    data: input.payload,
  });
  const status: DeliveryStatus = endpoint ? "pending" : "blocked_configuration";
  const maxAutomaticAttempts = endpoint?.max_automatic_attempts ?? 4;
  const payloadCiphertext = await encryptEnvelopeV1(body, input.env, {
    accountId: input.accountId,
    table: "outbound_deliveries",
    rowId: deliveryId,
    field: "payload_ciphertext",
  });
  let deliverySigningSecretCiphertext: string | null = null;
  if (endpoint) {
    const signingSecret = await decryptEnvelopeV1(endpoint.signing_secret_ciphertext, input.env, {
      accountId: input.accountId,
      table: "outbound_endpoints",
      rowId: endpoint.id,
      field: "signing_secret_ciphertext",
    });
    deliverySigningSecretCiphertext = await encryptEnvelopeV1(signingSecret, input.env, {
      accountId: input.accountId,
      table: "outbound_deliveries",
      rowId: deliveryId,
      field: "signing_secret_ciphertext",
    });
  }

  const statement = input.db
    .prepare(
      `INSERT INTO outbound_deliveries (
         id, account_id, endpoint_id, customer_id, license_id, event_type,
         recipient_email, idempotency_key, target_url,
         signing_secret_ciphertext, payload_ciphertext, payload_expires_at,
         status, attempt_count, automatic_attempt_count,
         max_automatic_attempts, next_attempt_at, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
         ?13, 0, 0, ?14, ?15, ?16, ?16
       )`
    )
    .bind(
      deliveryId,
      input.accountId,
      endpoint?.id ?? null,
      input.customerId ?? null,
      input.licenseId ?? null,
      input.eventType,
      input.recipientEmail,
      idempotencyKey,
      endpoint?.url ?? null,
      deliverySigningSecretCiphertext,
      payloadCiphertext,
      payloadExpiresAt,
      status,
      maxAutomaticAttempts,
      endpoint ? nowIso : null,
      nowIso
    );

  return {
    deliveryId,
    status,
    payloadExpiresAt,
    statements: [statement],
  };
}

export async function prepareEndpointTestDelivery(
  input: PrepareEndpointTestDeliveryInput
): Promise<PreparedNotificationDelivery> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const endpointResult = await input.db
    .prepare(
      `SELECT id, url, signing_secret_ciphertext, max_automatic_attempts
       FROM outbound_endpoints
       WHERE account_id = ?1 AND id = ?2 AND status = 'active'
       LIMIT 1`
    )
    .bind(input.accountId, input.endpointId)
    .all<NotificationEndpointRow>();
  const endpoint = endpointResult.results[0];
  if (!endpoint) throw new Error("OUTBOUND_ENDPOINT_NOT_FOUND");

  const deliveryId = `dly_${ulid().toLowerCase()}`;
  const payloadExpiresAt = new Date(now.getTime() + 3600_000).toISOString();
  const body = JSON.stringify({
    id: deliveryId,
    type: "endpoint.test",
    created_at: nowIso,
    data: { endpoint_id: endpoint.id, message: "LicenKit endpoint test" },
  });
  const signingSecret = await decryptEnvelopeV1(endpoint.signing_secret_ciphertext, input.env, {
    accountId: input.accountId,
    table: "outbound_endpoints",
    rowId: endpoint.id,
    field: "signing_secret_ciphertext",
  });
  const [payloadCiphertext, signingSecretCiphertext] = await Promise.all([
    encryptEnvelopeV1(body, input.env, {
      accountId: input.accountId,
      table: "outbound_deliveries",
      rowId: deliveryId,
      field: "payload_ciphertext",
    }),
    encryptEnvelopeV1(signingSecret, input.env, {
      accountId: input.accountId,
      table: "outbound_deliveries",
      rowId: deliveryId,
      field: "signing_secret_ciphertext",
    }),
  ]);
  const statement = input.db
    .prepare(
      `INSERT INTO outbound_deliveries (
         id, account_id, endpoint_id, event_type, idempotency_key, target_url,
         signing_secret_ciphertext, payload_ciphertext, payload_expires_at,
         status, attempt_count, automatic_attempt_count, max_automatic_attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, 'endpoint.test', ?4, ?5, ?6, ?7, ?8,
         'pending', 0, 0, ?9, ?10, ?10, ?10
       )`
    )
    .bind(
      deliveryId,
      input.accountId,
      endpoint.id,
      `endpoint.test:${deliveryId}`,
      endpoint.url,
      signingSecretCiphertext,
      payloadCiphertext,
      payloadExpiresAt,
      endpoint.max_automatic_attempts,
      nowIso
    );
  return { deliveryId, status: "pending", payloadExpiresAt, statements: [statement] };
}
