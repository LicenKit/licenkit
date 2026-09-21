import { ulid } from "ulid";
import {
  getEmailNotificationContract,
  validateEmailNotificationVariables,
} from "../../domain/email/contracts";
import { decryptEnvelopeV1, encryptEnvelopeV1 } from "../../infra/delivery/crypto";
import { getEmailProviderAdapter } from "../../infra/email/provider";
import { AppError } from "../../middleware/error";

export type EmailDeliveryStatus = "pending" | "waiting_configuration";

interface EmailDeliveryEnv {
  STORAGE_ENCRYPTION_KEY?: string;
}

interface PrepareEmailNotificationDeliveryBaseInput {
  db: D1Database;
  env: EmailDeliveryEnv;
  instanceId: string;
  notificationType: string;
  contractVersion: number;
  recipientEmail: string;
  /** 业务事件发生时产生的变量；公共变量由本服务补齐。 */
  variables: Readonly<Record<string, unknown>>;
  /** 业务内容自身的最晚发送时间，例如 Magic Link 的失效时间。 */
  sendExpiresAt?: string;
  now?: Date;
}

export type PrepareEmailNotificationDeliveryInput = PrepareEmailNotificationDeliveryBaseInput & (
  | { recipientType?: "customer"; customerId: string }
  | { recipientType: "instance_invitation"; customerId?: never }
);

export interface PreparedEmailNotificationDelivery {
  deliveryId: string;
  status: EmailDeliveryStatus;
  sendExpiresAt: string | null;
  variablesExpiresAt: null;
  statements: D1PreparedStatement[];
}

export interface ValidateEmailDeliveryConfigurationInput {
  db: D1Database;
  env: EmailDeliveryEnv;
  instanceId: string;
  notificationType: string;
  contractVersion: number;
}

interface InstanceEmailContextRow {
  name: string;
  slug: string;
  site_url: string;
}

interface ActiveEmailConfigurationRow {
  integration_id: string;
  provider: string;
  credential_ciphertext: string;
}

function appError(code: string, message: string, status: 400 | 404 | 409 | 500 = 400): AppError {
  return new AppError(code, message, status);
}

function sendExpiration(
  now: Date,
  requested?: string,
): string | null {
  if (requested === undefined) return null;
  const requestedDeadline = Date.parse(requested);
  if (!Number.isFinite(requestedDeadline) || requestedDeadline <= now.getTime()) {
    throw appError(
      "EMAIL_DELIVERY_SEND_EXPIRATION_INVALID",
      "The email Delivery send expiration must be a valid future time.",
    );
  }
  return new Date(requestedDeadline).toISOString();
}

async function instanceEmailContext(
  db: D1Database,
  instanceId: string,
): Promise<InstanceEmailContextRow> {
  const result = await db
    .prepare(
      `SELECT instance.name, instance.slug, instance.site_url
       FROM instances AS instance
       WHERE instance.id = ?1
       LIMIT 1`,
    )
    .bind(instanceId)
    .all<InstanceEmailContextRow>();
  const instance = result.results[0];
  if (!instance) throw appError("INSTANCE_NOT_FOUND", "The Instance was not found.", 404);
  return instance;
}

async function findActiveEmailConfiguration(
  db: D1Database,
  instanceId: string,
  notificationType: string,
  contractVersion: number,
): Promise<ActiveEmailConfigurationRow | undefined> {
  const result = await db
    .prepare(
      `SELECT integration.id AS integration_id, integration.provider,
              integration.credential_ciphertext
       FROM email_integrations AS integration
       JOIN email_template_bindings AS binding
         ON binding.instance_id = integration.instance_id
        AND binding.email_integration_id = integration.id
        AND binding.notification_type = ?2
        AND binding.contract_version = ?3
        AND binding.status = 'active'
       WHERE integration.instance_id = ?1
         AND integration.status = 'active'
       LIMIT 1`,
    )
    .bind(instanceId, notificationType, contractVersion)
    .all<ActiveEmailConfigurationRow>();
  return result.results[0];
}

function rejectCallerOwnedCommonVariables(
  variables: Readonly<Record<string, unknown>>,
): void {
  if (
    Object.prototype.hasOwnProperty.call(variables, "instance_name")
  ) {
    throw appError(
      "EMAIL_NOTIFICATION_COMMON_VARIABLE_FORBIDDEN",
      "Shared email variables are injected by the email Delivery service.",
    );
  }
}

/**
 * 生成一条邮件业务事实，并让调用方与业务变更放入同一个 D1 batch。
 * Delivery 只保存事件变量；实际发送时才读取当前 Integration 与 Binding。
 */
export async function prepareEmailNotificationDelivery(
  input: PrepareEmailNotificationDeliveryInput,
): Promise<PreparedEmailNotificationDelivery> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const deliveryId = `dly_${ulid().toLowerCase()}`;
  rejectCallerOwnedCommonVariables(input.variables);
  const sendExpiresAt = sendExpiration(now, input.sendExpiresAt);
  const instance = await instanceEmailContext(input.db, input.instanceId);
  const variables = validateEmailNotificationVariables(
    input.notificationType,
    input.contractVersion,
    {
      ...input.variables,
      instance_name: instance.name,
    },
    {
      trustedSiteUrl: instance.site_url,
      expectedInstanceSlug: instance.slug,
    },
  );
  const configuration = await findActiveEmailConfiguration(
    input.db,
    input.instanceId,
    input.notificationType,
    input.contractVersion,
  );
  const status: EmailDeliveryStatus = configuration ? "pending" : "waiting_configuration";
  const variablesCiphertext = await encryptEnvelopeV1(JSON.stringify(variables), input.env, {
    instanceId: input.instanceId,
    table: "email_deliveries",
    rowId: deliveryId,
    field: "variables_ciphertext",
  });
  const lastErrorJson = configuration
    ? null
    : JSON.stringify({
      outcome: "configuration_unavailable",
      source: "licenkit",
      code: "EMAIL_CONFIGURATION_NOT_FOUND",
      message: "No active email Integration and Template Binding match this notification contract.",
    });
  const statement = input.db
    .prepare(
      `INSERT INTO email_deliveries (
         id, instance_id, recipient_type, customer_id, notification_type, contract_version,
         recipient_email, variables_ciphertext, send_expires_at, variables_expires_at,
         status, attempt_count, next_attempt_at, last_error_json,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, 0, ?11, ?12, ?13, ?13)`,
    )
    .bind(
      deliveryId,
      input.instanceId,
      input.recipientType ?? "customer",
      input.recipientType === "instance_invitation" ? null : input.customerId,
      input.notificationType,
      input.contractVersion,
      input.recipientEmail,
      variablesCiphertext,
      sendExpiresAt,
      status,
      status === "pending" ? nowIso : null,
      lastErrorJson,
      nowIso,
    );
  return {
    deliveryId,
    status,
    sendExpiresAt,
    variablesExpiresAt: null,
    statements: [statement],
  };
}

/**
 * 公共 Magic Link 请求在查询客户身份前调用：缺少发送配置不是身份信号，
 * 但已配置却无法解密的凭证必须对所有请求一致失败。
 */
export async function validateEmailDeliveryConfiguration(
  input: ValidateEmailDeliveryConfigurationInput,
): Promise<void> {
  getEmailNotificationContract(input.notificationType, input.contractVersion);
  const configuration = await findActiveEmailConfiguration(
    input.db,
    input.instanceId,
    input.notificationType,
    input.contractVersion,
  );
  if (!configuration) return;
  const serialized = await decryptEnvelopeV1(
    configuration.credential_ciphertext,
    input.env,
    {
      instanceId: input.instanceId,
      table: "email_integrations",
      rowId: configuration.integration_id,
      field: "credential_ciphertext",
    },
  );
  let credential: unknown;
  try {
    credential = JSON.parse(serialized);
  } catch {
    throw appError(
      "EMAIL_PROVIDER_CREDENTIAL_INVALID",
      "The configured email Provider credential is invalid.",
      500,
    );
  }
  getEmailProviderAdapter(configuration.provider).validateCredentialEnvelope(credential);
}
