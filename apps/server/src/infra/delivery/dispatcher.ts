import { ulid } from "ulid";
import {
  buildCustomerPortalAccessUrl,
  getEmailNotificationContract,
  validateEmailNotificationVariables,
  type EmailVariableValue,
} from "../../domain/email/contracts";
import { sha256Hex } from "../crypto";
import {
  getEmailProviderAdapter,
  type EmailProviderAdapter,
  type EmailProviderErrorClassification,
  type EmailProviderSendInput,
  type EmailProviderSendResult,
} from "../email/provider";
import { createResendEmailProviderAdapter } from "../email/resend";
import { AppError } from "../../middleware/error";
import { prepareSystemIssueUpsert } from "../../services/operations/system-issues";
import {
  acceptedPayloadExpiration,
  type SensitiveDeliveryRetentionEnv,
} from "../../services/delivery/retention";
import { decryptEnvelopeV1, type DeliveryCryptoEnv } from "./crypto";

type FinalDispatchStatus =
  | "accepted"
  | "retry_scheduled"
  | "waiting_configuration"
  | "failed"
  | "expired";

interface DeliveryRow {
  id: string;
  instance_id: string;
  recipient_type: "customer" | "instance_invitation";
  customer_id: string | null;
  notification_type: string;
  contract_version: number;
  recipient_email: string;
  variables_ciphertext: string | null;
  send_expires_at: string | null;
  variables_expires_at: string | null;
  attempt_count: number;
  created_at: string;
  integration_id: string | null;
  provider: string | null;
  credential_ciphertext: string | null;
  default_from_email: string | null;
  default_from_name: string | null;
  reply_to_email: string | null;
  max_automatic_attempts: number | null;
  binding_id: string | null;
  binding_contract_version: number | null;
  provider_template_ref: string | null;
  site_url: string;
}

interface TestConfigurationRow {
  instance_name: string;
  site_url: string;
  integration_id: string;
  provider: string;
  credential_ciphertext: string;
  default_from_email: string;
  default_from_name: string | null;
  reply_to_email: string | null;
  binding_id: string;
  provider_template_ref: string;
}

export interface DispatchDeliveryInput {
  db: D1Database;
  env: DeliveryCryptoEnv & SensitiveDeliveryRetentionEnv & { ENVIRONMENT?: string };
  instanceId: string;
  deliveryId: string;
  workerId?: string;
  manual?: boolean;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface DispatchDeliveryResult {
  claimed: boolean;
  status?: FinalDispatchStatus;
  attemptNumber?: number;
  httpStatus?: number | null;
  errorCode?: string | null;
  outcomeUnknown?: boolean;
}

export interface TestEmailConfigurationInput {
  db: D1Database;
  env: DeliveryCryptoEnv & { ENVIRONMENT?: string };
  instanceId: string;
  emailIntegrationId: string;
  notificationType: string;
  contractVersion: number;
  recipientEmail: string;
  adminOrigin?: string;
  fetchImpl?: typeof fetch;
}

export interface TestEmailConfigurationResult {
  providerAccepted: boolean;
  provider: string;
  providerTemplateRef: string;
  recipientEmail: string;
  providerMessageId?: string;
  providerRequestId?: string;
  httpStatus?: number;
  error?: Record<string, unknown>;
}

interface MaterializedSend {
  adapter: EmailProviderAdapter;
  credential: ReturnType<EmailProviderAdapter["validateCredentialEnvelope"]>;
  from: string;
  to: string;
  replyTo?: string;
  templateRef: string;
  variables: Readonly<Record<string, EmailVariableValue>>;
  idempotencyKey: string;
}

function sanitizeEmailDiagnosticText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/\bre_[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]")
    .replace(
      /\bLK-[0-9A-HJKMNP-TV-Z]{6}(?:-[0-9A-HJKMNP-TV-Z]{6}){3}-[0-9A-HJKMNP-TV-Z]{2}\b/g,
      "[REDACTED_LICENSE_KEY]",
    )
    .replace(/\bmlk_[0-9a-f]{64}\b/g, "[REDACTED_MAGIC_LINK_TOKEN]")
    .replace(/([?&#](?:token|access_token)=)[^\s&#"'<>\[\]]+/gi, "$1[REDACTED_TOKEN]")
    .replace(
      /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi,
      "[REDACTED_EMAIL]",
    )
    .slice(0, 2048);
}

function changes(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

function fromAddress(row: {
  default_from_email: string;
  default_from_name: string | null;
}): string {
  const name = row.default_from_name?.trim();
  return name ? `${name} <${row.default_from_email}>` : row.default_from_email;
}

function adapterFor(provider: string, fetchImpl?: typeof fetch): EmailProviderAdapter {
  const registered = getEmailProviderAdapter(provider);
  if (fetchImpl && provider === "resend") {
    return createResendEmailProviderAdapter({ fetchImpl });
  }
  return registered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(serialized: string, code: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new AppError(code, "The encrypted email data is not valid JSON.", 500);
  }
  if (!isRecord(parsed)) {
    throw new AppError(code, "The encrypted email data must contain a JSON object.", 500);
  }
  return parsed;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function requestIdempotencyKey(
  deliveryId: string,
  request: Omit<MaterializedSend, "adapter" | "credential" | "idempotencyKey">,
): Promise<string> {
  return `email:${deliveryId}:${await sha256Hex(canonical(request))}`;
}

function localErrorJson(error: unknown, outcome = "configuration_invalid"): string {
  const code = error instanceof AppError
    ? error.code
    : typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code)
      : "EMAIL_CONFIGURATION_INVALID";
  const message = sanitizeEmailDiagnosticText(
    error instanceof Error ? error.message : String(error),
  ) ?? "The current email configuration is invalid.";
  return JSON.stringify({
    outcome,
    source: "licenkit",
    code,
    message,
    ...(error instanceof AppError && error.details ? { details: error.details } : {}),
  });
}

function providerErrorObject(
  provider: string,
  classification: EmailProviderErrorClassification,
): Record<string, unknown> {
  const outcomeUnknown =
    classification.failureClass === "timeout" ||
    classification.failureClass === "transport" ||
    classification.providerErrorCode === "missing_or_invalid_email_id";
  const outcome = outcomeUnknown
    ? "provider_result_unknown"
    : classification.action === "retry"
      ? "provider_rejected_retryable"
      : classification.action === "block_binding" || classification.action === "block_integration"
        ? "configuration_rejected"
        : "provider_rejected";
  return {
    outcome,
    source: provider,
    failure_class: classification.failureClass,
    ...(classification.httpStatus === undefined
      ? {}
      : { http_status: classification.httpStatus }),
    ...(classification.providerErrorType === undefined
      ? {}
      : { provider_error_type: classification.providerErrorType }),
    ...(classification.providerErrorCode === undefined
      ? {}
      : { code: classification.providerErrorCode }),
    ...(classification.providerErrorDetail === undefined
      ? {}
      : { message: sanitizeEmailDiagnosticText(classification.providerErrorDetail) }),
    ...(classification.providerRequestId === undefined
      ? {}
      : { request_id: classification.providerRequestId }),
    ...(classification.retryAfter === undefined
      ? {}
      : { retry_after: classification.retryAfter }),
    ...(classification.responseHeadersRedacted === undefined
      ? {}
      : { response_headers: classification.responseHeadersRedacted }),
    ...(classification.responseBodyRedacted === undefined
      ? {}
      : { response_body: classification.responseBodyRedacted }),
    ...(outcomeUnknown ? { possible_duplicate_on_resend: true } : {}),
  };
}

function errorCode(value: Record<string, unknown>): string | null {
  return typeof value.code === "string" ? value.code : null;
}

function backoffSeconds(attempt: number): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  const random = crypto.getRandomValues(new Uint16Array(1))[0] / 65535;
  return Math.round(base * (0.8 + random * 0.4));
}

function retryAfterTime(value: string | undefined, now: Date): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return now.getTime() + Number(value) * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadDelivery(
  db: D1Database,
  instanceId: string,
  deliveryId: string,
  workerId: string,
): Promise<DeliveryRow | undefined> {
  const result = await db
    .prepare(
      `SELECT delivery.id, delivery.instance_id, delivery.recipient_type, delivery.customer_id,
              delivery.notification_type, delivery.contract_version,
              delivery.recipient_email, delivery.variables_ciphertext,
              delivery.send_expires_at, delivery.variables_expires_at,
              delivery.attempt_count,
              delivery.created_at,
              integration.id AS integration_id, integration.provider,
              integration.credential_ciphertext,
              integration.default_from_email, integration.default_from_name,
              integration.reply_to_email, integration.max_automatic_attempts,
              binding.id AS binding_id,
              binding.contract_version AS binding_contract_version,
              binding.provider_template_ref,
              instance.site_url
       FROM email_deliveries AS delivery
       JOIN instances AS instance ON instance.id = delivery.instance_id
       LEFT JOIN email_integrations AS integration
         ON integration.instance_id = delivery.instance_id
        AND integration.status = 'active'
       LEFT JOIN email_template_bindings AS binding
        ON binding.instance_id = delivery.instance_id
        AND binding.email_integration_id = integration.id
        AND binding.notification_type = delivery.notification_type
        AND binding.status = 'active'
       WHERE delivery.instance_id = ?1
         AND delivery.id = ?2
         AND delivery.status = 'processing'
         AND delivery.locked_by = ?3
       LIMIT 1`,
    )
    .bind(instanceId, deliveryId, workerId)
    .all<DeliveryRow>();
  return result.results[0];
}

async function materializeDelivery(
  row: DeliveryRow,
  input: DispatchDeliveryInput,
): Promise<MaterializedSend> {
  if (
    !row.variables_ciphertext ||
    !row.integration_id ||
    !row.provider ||
    !row.credential_ciphertext ||
    !row.default_from_email ||
    !row.binding_id ||
    row.binding_contract_version === null ||
    !row.provider_template_ref ||
    row.max_automatic_attempts === null
  ) {
    throw new AppError(
      "EMAIL_CONFIGURATION_NOT_FOUND",
      "No active email Integration and Template Binding match this notification contract.",
      409,
      {
        notification_type: row.notification_type,
        contract_version: row.contract_version,
      },
    );
  }
  const [variablesSerialized, credentialSerialized] = await Promise.all([
    decryptEnvelopeV1(row.variables_ciphertext, input.env, {
      instanceId: row.instance_id,
      table: "email_deliveries",
      rowId: row.id,
      field: "variables_ciphertext",
    }),
    decryptEnvelopeV1(row.credential_ciphertext, input.env, {
      instanceId: row.instance_id,
      table: "email_integrations",
      rowId: row.integration_id,
      field: "credential_ciphertext",
    }),
  ]);
  const variables = validateEmailNotificationVariables(
    row.notification_type,
    row.binding_contract_version,
    parseJsonObject(variablesSerialized, "EMAIL_DELIVERY_VARIABLES_INVALID"),
    {
      trustedSiteUrl: row.site_url,
      authenticatedPreparedDelivery: true,
      environment: input.env.ENVIRONMENT,
    },
  );
  const adapter = adapterFor(row.provider, input.fetchImpl);
  const credential = adapter.validateCredentialEnvelope(
    parseJsonObject(credentialSerialized, "EMAIL_PROVIDER_CREDENTIAL_INVALID"),
  );
  const request = {
    from: fromAddress({
      default_from_email: row.default_from_email,
      default_from_name: row.default_from_name,
    }),
    to: row.recipient_email,
    ...(row.reply_to_email ? { replyTo: row.reply_to_email } : {}),
    templateRef: row.provider_template_ref,
    variables,
  };
  adapter.validateSendInput(request);
  return {
    adapter,
    credential,
    ...request,
    idempotencyKey: await requestIdempotencyKey(row.id, request),
  };
}

async function releaseAsConfigurationWait(
  input: DispatchDeliveryInput,
  row: DeliveryRow,
  workerId: string,
  error: unknown,
  nowIso: string,
): Promise<void> {
  const diagnostic = localErrorJson(error);
  const parsedDiagnostic = JSON.parse(diagnostic) as Record<string, unknown>;
  await input.db.batch([
    prepareSystemIssueUpsert({
      db: input.db,
      instanceId: input.instanceId,
      category: "email",
      sourceType: "email_delivery",
      sourceId: input.deliveryId,
      operation: row.notification_type,
      errorCode: errorCode(parsedDiagnostic) ?? "EMAIL_CONFIGURATION_INVALID",
      errorDetailJson: diagnostic,
      nowIso,
    }),
    input.db.prepare(
      `UPDATE email_deliveries
       SET status = 'waiting_configuration', next_attempt_at = NULL,
           last_error_json = ?1, locked_by = NULL, locked_until = NULL,
           updated_at = ?2
       WHERE instance_id = ?3 AND id = ?4 AND locked_by = ?5`,
    )
      .bind(diagnostic, nowIso, input.instanceId, input.deliveryId, workerId),
  ]);
}

function testVariables(
  configuration: TestConfigurationRow,
  notificationType: string,
  contractVersion: number,
  adminOrigin?: string,
  environment?: string,
): Readonly<Record<string, EmailVariableValue>> {
  const contract = getEmailNotificationContract(notificationType, contractVersion);
  const values: Record<string, EmailVariableValue> = Object.fromEntries(
    contract.variables
      .filter((descriptor) => descriptor.required)
      .map((descriptor) => [descriptor.name, descriptor.example]),
  );
  values.instance_name = configuration.instance_name;
  if (Object.prototype.hasOwnProperty.call(values, "access_url")) {
    if (!configuration.site_url) {
      throw new AppError(
        "EMAIL_TRUSTED_SITE_URL_REQUIRED",
        "The trusted Site URL is required to test this email template.",
        409,
      );
    }
    values.access_url = buildCustomerPortalAccessUrl({
      trustedSiteUrl: configuration.site_url,
      oneTimeToken: `mlk_${"0".repeat(64)}`,
      environment,
    });
  }
  if (Object.prototype.hasOwnProperty.call(values, "invitation_url")) {
    if (!adminOrigin) {
      throw new AppError(
        "EMAIL_TRUSTED_ADMIN_ORIGIN_REQUIRED",
        "The trusted Admin Origin is required to test this email template.",
        409,
      );
    }
    const invitationUrl = new URL(adminOrigin);
    invitationUrl.pathname = "/admin/invitations/accept";
    invitationUrl.hash = `token=ivk_${"0".repeat(64)}`;
    values.invitation_url = invitationUrl.toString();
  }
  return validateEmailNotificationVariables(
    notificationType,
    contractVersion,
    values,
    {
      trustedSiteUrl: configuration.site_url,
      trustedAdminOrigin: adminOrigin,
      environment,
    },
  );
}

/** 直接调用 Provider 发送测试邮件；不创建 Delivery，也不保存测试结果。 */
export async function testEmailConfiguration(
  input: TestEmailConfigurationInput,
): Promise<TestEmailConfigurationResult> {
  const result = await input.db
    .prepare(
      `SELECT instance.name AS instance_name, instance.site_url,
              integration.id AS integration_id, integration.provider,
              integration.credential_ciphertext,
              integration.default_from_email, integration.default_from_name,
              integration.reply_to_email,
              binding.id AS binding_id, binding.provider_template_ref
       FROM instances AS instance
       JOIN email_integrations AS integration
         ON integration.instance_id = instance.id
        AND integration.id = ?2
        AND integration.status = 'active'
       JOIN email_template_bindings AS binding
         ON binding.instance_id = instance.id
        AND binding.email_integration_id = integration.id
        AND binding.notification_type = ?3
        AND binding.contract_version = ?4
        AND binding.status = 'active'
       WHERE instance.id = ?1
       LIMIT 1`,
    )
    .bind(
      input.instanceId,
      input.emailIntegrationId,
      input.notificationType,
      input.contractVersion,
    )
    .all<TestConfigurationRow>();
  const configuration = result.results[0];
  if (!configuration) {
    throw new AppError(
      "EMAIL_TEST_CONFIGURATION_NOT_FOUND",
      "The active email Integration or Template Binding was not found.",
      404,
    );
  }
  const adapter = adapterFor(configuration.provider, input.fetchImpl);
  let request: EmailProviderSendInput;
  try {
    const variables = testVariables(
      configuration,
      input.notificationType,
      input.contractVersion,
      input.adminOrigin,
      input.env.ENVIRONMENT,
    );
    const credentialSerialized = await decryptEnvelopeV1(
      configuration.credential_ciphertext,
      input.env,
      {
        instanceId: input.instanceId,
        table: "email_integrations",
        rowId: configuration.integration_id,
        field: "credential_ciphertext",
      },
    );
    request = {
      credential: adapter.validateCredentialEnvelope(
        parseJsonObject(credentialSerialized, "EMAIL_PROVIDER_CREDENTIAL_INVALID"),
      ),
      from: fromAddress(configuration),
      to: input.recipientEmail,
      ...(configuration.reply_to_email ? { replyTo: configuration.reply_to_email } : {}),
      templateRef: configuration.provider_template_ref,
      variables,
      idempotencyKey: `email-test:${ulid().toLowerCase()}`,
    };
    adapter.validateSendInput(request);
  } catch (error) {
    return {
      providerAccepted: false,
      provider: configuration.provider,
      providerTemplateRef: configuration.provider_template_ref,
      recipientEmail: input.recipientEmail,
      error: JSON.parse(localErrorJson(error)),
    };
  }
  try {
    const sent = await adapter.send(request);
    return {
      providerAccepted: true,
      provider: configuration.provider,
      providerTemplateRef: configuration.provider_template_ref,
      recipientEmail: input.recipientEmail,
      providerMessageId: sent.providerMessageId,
      ...(sent.providerRequestId ? { providerRequestId: sent.providerRequestId } : {}),
      httpStatus: sent.httpStatus,
    };
  } catch (error) {
    const classified = adapter.classifyError(error);
    return {
      providerAccepted: false,
      provider: configuration.provider,
      providerTemplateRef: configuration.provider_template_ref,
      recipientEmail: input.recipientEmail,
      ...(classified.providerRequestId
        ? { providerRequestId: classified.providerRequestId }
        : {}),
      ...(classified.httpStatus === undefined ? {} : { httpStatus: classified.httpStatus }),
      error: providerErrorObject(configuration.provider, classified),
    };
  }
}

export async function dispatchDelivery(
  input: DispatchDeliveryInput,
): Promise<DispatchDeliveryResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const workerId = input.workerId ?? `worker_${ulid().toLowerCase()}`;
  const lockedUntil = new Date(now.getTime() + 60_000).toISOString();
  const manual = input.manual === true;

  const expirationDiagnostic = JSON.stringify({
    outcome: "send_expired",
    source: "licenkit",
    code: "EMAIL_DELIVERY_SEND_EXPIRED",
    message: "The email content expired before the email was accepted.",
  });
  const expirationResults = await input.db.batch([
    input.db.prepare(
      `UPDATE email_deliveries
       SET status = 'expired', variables_ciphertext = NULL,
           next_attempt_at = NULL, locked_by = NULL, locked_until = NULL,
           last_error_json = ?1, updated_at = ?2
       WHERE instance_id = ?3 AND id = ?4
         AND status NOT IN ('accepted', 'expired', 'cancelled')
         AND send_expires_at IS NOT NULL
         AND send_expires_at <= ?2
         AND (status <> 'processing' OR locked_until <= ?2)`,
    ).bind(expirationDiagnostic, nowIso, input.instanceId, input.deliveryId),
    input.db.prepare(
      `UPDATE billing_checkout_verifications
       SET status = 'expired', completed_at = NULL,
           last_error_code = 'EMAIL_DELIVERY_SEND_EXPIRED',
           last_error_detail = 'The related email expired before Provider acceptance.',
           updated_at = ?1
       WHERE instance_id = ?2 AND delivery_id = ?3
         AND status = 'delivery_pending'
         AND EXISTS (
           SELECT 1 FROM email_deliveries AS delivery
           WHERE delivery.instance_id = ?2 AND delivery.id = ?3
             AND delivery.status = 'expired' AND delivery.updated_at = ?1
         )`,
    ).bind(nowIso, input.instanceId, input.deliveryId),
  ]);
  if (changes(expirationResults[0]) > 0) {
    await prepareSystemIssueUpsert({
      db: input.db,
      instanceId: input.instanceId,
      category: "email",
      sourceType: "email_delivery",
      sourceId: input.deliveryId,
      operation: "send_expiration",
      errorCode: "EMAIL_DELIVERY_SEND_EXPIRED",
      errorDetailJson: expirationDiagnostic,
      nowIso,
    }).run();
    return { claimed: true, status: "expired" };
  }

  const claim = await input.db
    .prepare(
      `UPDATE email_deliveries
       SET status = 'processing', locked_by = ?1, locked_until = ?2, updated_at = ?3
       WHERE instance_id = ?4 AND id = ?5
         AND variables_ciphertext IS NOT NULL
         AND (send_expires_at IS NULL OR send_expires_at > ?3)
         AND (
           (?6 = 1 AND status IN (
             'pending', 'retry_scheduled', 'waiting_configuration', 'failed'
           ))
           OR (?6 = 0 AND (
             (status IN ('pending', 'retry_scheduled')
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
             OR (status = 'processing' AND locked_until <= ?3)
           ))
         )`,
    )
    .bind(workerId, lockedUntil, nowIso, input.instanceId, input.deliveryId, manual ? 1 : 0)
    .run();
  if (changes(claim) !== 1) return { claimed: false };

  const row = await loadDelivery(input.db, input.instanceId, input.deliveryId, workerId);
  if (!row) return { claimed: false };

  let materialized: MaterializedSend;
  let payloadExpiresAt: string;
  try {
    materialized = await materializeDelivery(row, input);
    // Validate retention configuration before contacting the Provider. Once the
    // Provider accepts a request, LicenKit must be able to persist that fact.
    payloadExpiresAt = acceptedPayloadExpiration(now, input.env);
  } catch (error) {
    await releaseAsConfigurationWait(input, row, workerId, error, nowIso);
    return {
      claimed: true,
      status: "waiting_configuration",
      errorCode: error instanceof AppError ? error.code : "EMAIL_CONFIGURATION_INVALID",
    };
  }

  const maxAutomaticAttempts = row.max_automatic_attempts!;
  if (!manual && row.attempt_count >= maxAutomaticAttempts) {
    const error = {
      outcome: "automatic_attempt_limit_reached",
      source: "licenkit",
      code: "EMAIL_AUTOMATIC_ATTEMPT_LIMIT_REACHED",
      message: "The current email Integration automatic attempt limit has been reached.",
      attempt_count: row.attempt_count,
      max_automatic_attempts: maxAutomaticAttempts,
    };
    await input.db.batch([
      prepareSystemIssueUpsert({
        db: input.db,
        instanceId: row.instance_id,
        category: "email",
        sourceType: "email_delivery",
        sourceId: row.id,
        operation: row.notification_type,
        errorCode: "EMAIL_AUTOMATIC_ATTEMPT_LIMIT_REACHED",
        errorDetailJson: JSON.stringify(error),
        nowIso,
      }),
      input.db.prepare(
        `UPDATE email_deliveries
         SET status = 'failed', next_attempt_at = NULL, last_error_json = ?1,
             locked_by = NULL, locked_until = NULL, updated_at = ?2
         WHERE instance_id = ?3 AND id = ?4 AND locked_by = ?5`,
      )
        .bind(JSON.stringify(error), nowIso, row.instance_id, row.id, workerId),
    ]);
    return {
      claimed: true,
      status: "failed",
      errorCode: "EMAIL_AUTOMATIC_ATTEMPT_LIMIT_REACHED",
    };
  }

  const attemptNumber = row.attempt_count + 1;
  const counted = await input.db
    .prepare(
      `UPDATE email_deliveries
       SET attempt_count = ?1, updated_at = ?2
       WHERE instance_id = ?3 AND id = ?4
         AND status = 'processing' AND locked_by = ?5 AND attempt_count = ?6`,
    )
    .bind(attemptNumber, nowIso, row.instance_id, row.id, workerId, row.attempt_count)
    .run();
  if (changes(counted) !== 1) return { claimed: false };

  let sent: EmailProviderSendResult | undefined;
  let classification: EmailProviderErrorClassification | undefined;
  try {
    sent = await materialized.adapter.send({
      credential: materialized.credential,
      from: materialized.from,
      to: materialized.to,
      ...(materialized.replyTo ? { replyTo: materialized.replyTo } : {}),
      templateRef: materialized.templateRef,
      variables: materialized.variables,
      idempotencyKey: materialized.idempotencyKey,
    });
  } catch (error) {
    classification = materialized.adapter.classifyError(error);
  }

  if (sent) {
    const acceptedResults = await input.db.batch([
      input.db
        .prepare(
          `UPDATE email_deliveries
           SET status = 'accepted', next_attempt_at = NULL,
               provider_message_id = ?1, last_error_json = NULL,
               variables_expires_at = ?2, accepted_at = ?3,
               locked_by = NULL, locked_until = NULL, updated_at = ?3
           WHERE instance_id = ?4 AND id = ?5
             AND status = 'processing' AND locked_by = ?6`,
        )
        .bind(sent.providerMessageId, payloadExpiresAt, nowIso, row.instance_id, row.id, workerId),
      input.db
        .prepare(
          `UPDATE billing_checkout_verifications
           SET status = 'completed', completed_at = ?1, updated_at = ?1
           WHERE instance_id = ?2 AND delivery_id = ?3
             AND status = 'delivery_pending'
             AND EXISTS (
               SELECT 1 FROM email_deliveries AS delivery
               WHERE delivery.instance_id = ?2 AND delivery.id = ?3
                 AND delivery.status = 'accepted'
             )`,
        )
        .bind(nowIso, row.instance_id, row.id),
    ]);
    if (changes(acceptedResults[0]) !== 1) return { claimed: false };
    return {
      claimed: true,
      status: "accepted",
      attemptNumber,
      httpStatus: sent.httpStatus,
      errorCode: null,
    };
  }

  const failure = classification!;
  const diagnostic = providerErrorObject(row.provider!, failure);
  const outcomeUnknown = diagnostic.outcome === "provider_result_unknown";
  const configurationFailure =
    failure.action === "block_integration" || failure.action === "block_binding";
  const canRetry = failure.action === "retry" && !outcomeUnknown;
  const retryAt = Math.max(
    now.getTime() + backoffSeconds(attemptNumber) * 1000,
    retryAfterTime(failure.retryAfter, now) ?? 0,
  );
  const withinSendWindow = row.send_expires_at === null
    || retryAt < Date.parse(row.send_expires_at);
  const hasBudget = attemptNumber < maxAutomaticAttempts;
  const status: FinalDispatchStatus = configurationFailure
    ? "waiting_configuration"
    : canRetry && withinSendWindow && hasBudget
      ? "retry_scheduled"
      : "failed";
  const nextAttemptAt = status === "retry_scheduled" ? new Date(retryAt).toISOString() : null;
  await input.db.batch([
    prepareSystemIssueUpsert({
      db: input.db,
      instanceId: row.instance_id,
      category: "email",
      sourceType: "email_delivery",
      sourceId: row.id,
      operation: row.notification_type,
      errorCode: errorCode(diagnostic) ?? `EMAIL_PROVIDER_${failure.failureClass.toUpperCase()}`,
      errorDetailJson: JSON.stringify(diagnostic),
      nowIso,
    }),
    input.db
      .prepare(
        `UPDATE email_deliveries
         SET status = ?1, next_attempt_at = ?2, last_error_json = ?3,
             locked_by = NULL, locked_until = NULL, updated_at = ?4
         WHERE instance_id = ?5 AND id = ?6 AND locked_by = ?7`,
      )
      .bind(
        status,
        nextAttemptAt,
        JSON.stringify(diagnostic),
        nowIso,
        row.instance_id,
        row.id,
        workerId,
      ),
  ]);
  return {
    claimed: true,
    status,
    attemptNumber,
    httpStatus: failure.httpStatus ?? null,
    errorCode: errorCode(diagnostic),
    outcomeUnknown,
  };
}
