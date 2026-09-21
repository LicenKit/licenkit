import { Hono, type Context } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type { AppContext } from "../../types";
import {
  getEmailNotificationContract,
  listEmailNotificationContracts,
} from "../../domain/email/contracts";
import { encryptEnvelopeV1 } from "../../infra/delivery/crypto";
import {
  dispatchDelivery,
  testEmailConfiguration,
} from "../../infra/delivery/dispatcher";
import { getEmailProviderAdapter } from "../../infra/email/provider";
import { getEmailProviderTemplateExample } from "../../infra/email/provider-template-registry";
import { adminCsrf, requireAdminAppOrigin, requireRole } from "../../middleware/auth";
import { AppError, ConflictError, NotFoundError } from "../../middleware/error";
import { prepareAuditInsert } from "../../services/identity/audit";
import { requestIp } from "../../services/identity/session";
import { toSnakeCaseJson } from "./snake-case-json";

const READ_ROLES = ["owner", "admin", "member", "viewer"] as const;

const EmailIntegrationCreateSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  api_key: z.string().min(1).max(2048),
  default_from_email: z.string().trim().email().max(320),
  default_from_name: z.string().trim().min(1).max(120).optional(),
  reply_to_email: z.string().trim().email().max(320).optional(),
  max_automatic_attempts: z.number().int().min(1).max(20).default(4),
}).strict().transform((input) => ({
  provider: input.provider,
  name: input.name,
  apiKey: input.api_key,
  defaultFromEmail: input.default_from_email,
  defaultFromName: input.default_from_name,
  replyToEmail: input.reply_to_email,
  maxAutomaticAttempts: input.max_automatic_attempts,
}));

const EmailIntegrationUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  default_from_email: z.string().trim().email().max(320).optional(),
  default_from_name: z.string().trim().min(1).max(120).nullable().optional(),
  reply_to_email: z.string().trim().email().max(320).nullable().optional(),
  max_automatic_attempts: z.number().int().min(1).max(20).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required")
  .transform((input) => ({
    name: input.name,
    defaultFromEmail: input.default_from_email,
    defaultFromName: input.default_from_name,
    replyToEmail: input.reply_to_email,
    maxAutomaticAttempts: input.max_automatic_attempts,
  }));

const RotateCredentialSchema = z.object({
  api_key: z.string().min(1).max(2048),
}).strict().transform((input) => ({ apiKey: input.api_key }));

const TemplateBindingSchema = z.object({
  contract_version: z.number().int().min(1),
  provider_template_ref: z.string().trim().min(1).max(512),
}).strict().transform((input) => ({
  contractVersion: input.contract_version,
  providerTemplateRef: input.provider_template_ref,
}));

export const EmailConfigurationTestSchema = z.object({
  recipient_email: z.string().trim().email().max(320),
}).strict().transform((input) => ({ recipientEmail: input.recipient_email }));

const ManualRetrySchema = z.object({
  confirm_possible_duplicate: z.boolean().optional(),
}).strict().transform((input) => ({
  confirmPossibleDuplicate: input.confirm_possible_duplicate,
}));

interface EmailIntegrationRow {
  id: string;
  provider: string;
  name: string;
  credential_configured: number;
  default_from_email: string;
  default_from_name: string | null;
  reply_to_email: string | null;
  max_automatic_attempts: number;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

interface EmailTemplateBindingRow {
  id: string;
  email_integration_id: string;
  notification_type: string;
  contract_version: number;
  provider_template_ref: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

interface EmailDeliveryRow {
  id: string;
  recipient_type: "customer" | "instance_invitation";
  customer_id: string | null;
  notification_type: string;
  contract_version: number;
  recipient_email: string;
  send_expires_at: string | null;
  variables_expires_at: string | null;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  provider_message_id: string | null;
  last_error_json: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

function mutationGuards() {
  return [requireAdminAppOrigin, adminCsrf, requireRole(["owner", "admin"])] as const;
}

async function one<T>(statement: D1PreparedStatement): Promise<T | undefined> {
  const result = await statement.all<T>();
  return result.results[0];
}

function formatFrom(email: string, name: string | null | undefined): string {
  return name ? `${name} <${email}>` : email;
}

function validateIntegrationSendingConfiguration(input: {
  provider: string;
  defaultFromEmail: string;
  defaultFromName?: string | null;
  replyToEmail?: string | null;
}): void {
  getEmailProviderAdapter(input.provider).validateSendInput({
    from: formatFrom(input.defaultFromEmail, input.defaultFromName),
    to: "delivered+licenkit-validation@resend.dev",
    ...(input.replyToEmail ? { replyTo: input.replyToEmail } : {}),
    templateRef: "licenkit-configuration-validation",
    variables: {},
  });
}

function serializeIntegration(row: EmailIntegrationRow) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    default_from_email: row.default_from_email,
    default_from_name: row.default_from_name,
    reply_to_email: row.reply_to_email,
    max_automatic_attempts: row.max_automatic_attempts,
    status: row.status,
    credential_configured: row.credential_configured === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeBinding(row: EmailTemplateBindingRow) {
  return {
    id: row.id,
    email_integration_id: row.email_integration_id,
    notification_type: row.notification_type,
    contract_version: row.contract_version,
    provider_template_ref: row.provider_template_ref,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseLastError(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { outcome: "invalid_diagnostic", source: "licenkit", raw: value };
  } catch {
    return { outcome: "invalid_diagnostic", source: "licenkit", raw: value };
  }
}

function serializeDelivery(row: EmailDeliveryRow) {
  return {
    id: row.id,
    recipient_type: row.recipient_type,
    customer_id: row.customer_id,
    notification_type: row.notification_type,
    contract_version: row.contract_version,
    recipient_email: row.recipient_email,
    send_expires_at: row.send_expires_at,
    variables_expires_at: row.variables_expires_at,
    status: row.status,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    provider_message_id: row.provider_message_id,
    last_error: toSnakeCaseJson(parseLastError(row.last_error_json)),
    accepted_at: row.accepted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function requireIntegration(
  c: Context<AppContext>,
  integrationId: string,
): Promise<EmailIntegrationRow> {
  const row = await one<EmailIntegrationRow>(
    c.env.DB
      .prepare(
        `SELECT id, provider, name, 1 AS credential_configured,
                default_from_email, default_from_name, reply_to_email,
                max_automatic_attempts, status, created_at, updated_at
         FROM email_integrations
         WHERE instance_id = ?1 AND id = ?2
         LIMIT 1`,
      )
      .bind(c.get("instanceId")!, integrationId),
  );
  if (!row) throw new NotFoundError("Email Integration not found");
  return row;
}

async function requireBinding(
  c: Context<AppContext>,
  integrationId: string,
  notificationType: string,
): Promise<EmailTemplateBindingRow> {
  const row = await one<EmailTemplateBindingRow>(
    c.env.DB
      .prepare(
        `SELECT id, email_integration_id, notification_type, contract_version,
                provider_template_ref, status, created_at, updated_at
         FROM email_template_bindings
         WHERE instance_id = ?1 AND email_integration_id = ?2
           AND notification_type = ?3
         ORDER BY contract_version DESC
         LIMIT 1`,
      )
      .bind(c.get("instanceId")!, integrationId, notificationType),
  );
  if (!row) throw new NotFoundError("Email Template Binding not found");
  return row;
}

function audit(c: Context<AppContext>, input: {
  action: string;
  resourceType: string;
  resourceId: string;
  details?: Record<string, unknown>;
  now?: string;
}) {
  return prepareAuditInsert({
    db: c.env.DB,
    instanceId: c.get("instanceId")!,
    actor: { type: "user", id: c.get("userId")! },
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    details: input.details,
    requestId: c.get("requestId"),
    ip: requestIp(c),
    userAgent: c.req.header("user-agent"),
    now: input.now,
  });
}

export const adminEmailTemplateContractsRouter = new Hono<AppContext>();

adminEmailTemplateContractsRouter.get("/", requireRole([...READ_ROLES]), (c) =>
  c.json({ success: true, data: { items: toSnakeCaseJson(listEmailNotificationContracts()) } }));

adminEmailTemplateContractsRouter.get(
  "/:notificationType/versions/:contractVersion/examples/:provider",
  requireRole([...READ_ROLES]),
  (c) => {
    const version = z.coerce.number().int().min(1).parse(c.req.param("contractVersion"));
    return c.json({
      success: true,
      data: toSnakeCaseJson(getEmailProviderTemplateExample(
        c.req.param("provider"),
        c.req.param("notificationType"),
        version,
      )),
    });
  },
);

export const adminEmailIntegrationsRouter = new Hono<AppContext>();

adminEmailIntegrationsRouter.get("/", requireRole([...READ_ROLES]), async (c) => {
  const result = await c.env.DB
    .prepare(
      `SELECT id, provider, name, 1 AS credential_configured,
              default_from_email, default_from_name, reply_to_email,
              max_automatic_attempts, status, created_at, updated_at
       FROM email_integrations
       WHERE instance_id = ?1
       ORDER BY created_at DESC`,
    )
    .bind(c.get("instanceId")!)
    .all<EmailIntegrationRow>();
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: { items: result.results.map(serializeIntegration) } });
});

adminEmailIntegrationsRouter.post("/", ...mutationGuards(), async (c) => {
  const input = EmailIntegrationCreateSchema.parse(await c.req.json());
  const adapter = getEmailProviderAdapter(input.provider);
  const credential = adapter.validateCredentialEnvelope({ version: 1, apiKey: input.apiKey });
  validateIntegrationSendingConfiguration(input);
  const instanceId = c.get("instanceId")!;
  const active = await one<{ id: string }>(
    c.env.DB.prepare(
      `SELECT id FROM email_integrations
       WHERE instance_id = ?1 AND status = 'active' LIMIT 1`,
    ).bind(instanceId),
  );
  if (active) {
    throw new ConflictError(
      "EMAIL_INTEGRATION_ACTIVE_EXISTS",
      "This Instance already has an active Email Integration.",
    );
  }
  const integrationId = `emi_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();
  const credentialCiphertext = await encryptEnvelopeV1(JSON.stringify(credential), c.env, {
    instanceId,
    table: "email_integrations",
    rowId: integrationId,
    field: "credential_ciphertext",
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO email_integrations (
         id, instance_id, provider, name, credential_ciphertext,
         default_from_email, default_from_name, reply_to_email,
         max_automatic_attempts, status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?10)`,
    ).bind(
      integrationId,
      instanceId,
      input.provider,
      input.name,
      credentialCiphertext,
      input.defaultFromEmail,
      input.defaultFromName ?? null,
      input.replyToEmail ?? null,
      input.maxAutomaticAttempts,
      now,
    ),
    audit(c, {
      action: "admin.email_integration.created",
      resourceType: "email_integration",
      resourceId: integrationId,
      details: {
        provider: input.provider,
        name: input.name,
        defaultFromEmail: input.defaultFromEmail,
        defaultFromName: input.defaultFromName ?? null,
        replyToEmail: input.replyToEmail ?? null,
        maxAutomaticAttempts: input.maxAutomaticAttempts,
      },
      now,
    }),
  ]);
  return c.json({
    success: true,
    data: serializeIntegration({
      id: integrationId,
      provider: input.provider,
      name: input.name,
      credential_configured: 1,
      default_from_email: input.defaultFromEmail,
      default_from_name: input.defaultFromName ?? null,
      reply_to_email: input.replyToEmail ?? null,
      max_automatic_attempts: input.maxAutomaticAttempts,
      status: "active",
      created_at: now,
      updated_at: now,
    }),
  }, 201);
});

adminEmailIntegrationsRouter.patch("/:integrationId", ...mutationGuards(), async (c) => {
  const input = EmailIntegrationUpdateSchema.parse(await c.req.json());
  const instanceId = c.get("instanceId")!;
  const integrationId = c.req.param("integrationId");
  const existing = await requireIntegration(c, integrationId);
  const next = {
    name: input.name ?? existing.name,
    defaultFromEmail: input.defaultFromEmail ?? existing.default_from_email,
    defaultFromName: input.defaultFromName === undefined
      ? existing.default_from_name
      : input.defaultFromName,
    replyToEmail: input.replyToEmail === undefined ? existing.reply_to_email : input.replyToEmail,
    maxAutomaticAttempts: input.maxAutomaticAttempts ?? existing.max_automatic_attempts,
  };
  validateIntegrationSendingConfiguration({ provider: existing.provider, ...next });
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE email_integrations
       SET name = ?1, default_from_email = ?2, default_from_name = ?3,
           reply_to_email = ?4, max_automatic_attempts = ?5, updated_at = ?6
       WHERE instance_id = ?7 AND id = ?8`,
    ).bind(
      next.name,
      next.defaultFromEmail,
      next.defaultFromName,
      next.replyToEmail,
      next.maxAutomaticAttempts,
      now,
      instanceId,
      integrationId,
    ),
    audit(c, {
      action: "admin.email_integration.updated",
      resourceType: "email_integration",
      resourceId: integrationId,
      details: {
        changedFields: Object.entries(input)
          .filter(([, value]) => value !== undefined)
          .map(([field]) => field),
      },
      now,
    }),
  ]);
  return c.json({
    success: true,
    data: serializeIntegration({
      ...existing,
      name: next.name,
      default_from_email: next.defaultFromEmail,
      default_from_name: next.defaultFromName,
      reply_to_email: next.replyToEmail,
      max_automatic_attempts: next.maxAutomaticAttempts,
      updated_at: now,
    }),
  });
});

adminEmailIntegrationsRouter.post(
  "/:integrationId/rotate-credential",
  ...mutationGuards(),
  async (c) => {
    const input = RotateCredentialSchema.parse(await c.req.json());
    const instanceId = c.get("instanceId")!;
    const integrationId = c.req.param("integrationId");
    const existing = await requireIntegration(c, integrationId);
    const credential = getEmailProviderAdapter(existing.provider)
      .validateCredentialEnvelope({ version: 1, apiKey: input.apiKey });
    const encrypted = await encryptEnvelopeV1(JSON.stringify(credential), c.env, {
      instanceId,
      table: "email_integrations",
      rowId: integrationId,
      field: "credential_ciphertext",
    });
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE email_integrations
         SET credential_ciphertext = ?1, updated_at = ?2
         WHERE instance_id = ?3 AND id = ?4`,
      ).bind(encrypted, now, instanceId, integrationId),
      audit(c, {
        action: "admin.email_integration.credential_rotated",
        resourceType: "email_integration",
        resourceId: integrationId,
        now,
      }),
    ]);
    return c.json({
      success: true,
      data: { id: integrationId, credential_configured: true },
    });
  },
);

adminEmailIntegrationsRouter.post("/:integrationId/disable", ...mutationGuards(), async (c) => {
  const integrationId = c.req.param("integrationId");
  const existing = await requireIntegration(c, integrationId);
  if (existing.status === "disabled") {
    return c.json({ success: true, data: { id: integrationId, status: "disabled" } });
  }
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE email_integrations SET status = 'disabled', updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3`,
    ).bind(now, c.get("instanceId")!, integrationId),
    audit(c, {
      action: "admin.email_integration.disabled",
      resourceType: "email_integration",
      resourceId: integrationId,
      now,
    }),
  ]);
  return c.json({ success: true, data: { id: integrationId, status: "disabled" } });
});

adminEmailIntegrationsRouter.post("/:integrationId/enable", ...mutationGuards(), async (c) => {
  const instanceId = c.get("instanceId")!;
  const integrationId = c.req.param("integrationId");
  const existing = await requireIntegration(c, integrationId);
  if (existing.status === "active") {
    return c.json({ success: true, data: { id: integrationId, status: "active" } });
  }
  const conflicting = await one<{ id: string }>(
    c.env.DB.prepare(
      `SELECT id FROM email_integrations
       WHERE instance_id = ?1 AND status = 'active' AND id <> ?2 LIMIT 1`,
    ).bind(instanceId, integrationId),
  );
  if (conflicting) {
    throw new ConflictError(
      "EMAIL_INTEGRATION_ACTIVE_EXISTS",
      "This Instance already has an active Email Integration.",
    );
  }
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE email_integrations SET status = 'active', updated_at = ?1
       WHERE instance_id = ?2 AND id = ?3`,
    ).bind(now, instanceId, integrationId),
    audit(c, {
      action: "admin.email_integration.enabled",
      resourceType: "email_integration",
      resourceId: integrationId,
      now,
    }),
  ]);
  return c.json({ success: true, data: { id: integrationId, status: "active" } });
});

adminEmailIntegrationsRouter.get(
  "/:integrationId/template-bindings",
  requireRole([...READ_ROLES]),
  async (c) => {
    const instanceId = c.get("instanceId")!;
    const integrationId = c.req.param("integrationId");
    await requireIntegration(c, integrationId);
    const result = await c.env.DB.prepare(
      `SELECT id, email_integration_id, notification_type, contract_version,
              provider_template_ref, status, created_at, updated_at
       FROM email_template_bindings
       WHERE instance_id = ?1 AND email_integration_id = ?2
       ORDER BY notification_type, contract_version`,
    ).bind(instanceId, integrationId).all<EmailTemplateBindingRow>();
    return c.json({
      success: true,
      data: { items: result.results.map(serializeBinding) },
    });
  },
);

adminEmailIntegrationsRouter.put(
  "/:integrationId/template-bindings/:notificationType",
  ...mutationGuards(),
  async (c) => {
    const input = TemplateBindingSchema.parse(await c.req.json());
    const instanceId = c.get("instanceId")!;
    const integrationId = c.req.param("integrationId");
    const notificationType = c.req.param("notificationType");
    const integration = await requireIntegration(c, integrationId);
    const contract = getEmailNotificationContract(notificationType, input.contractVersion);
    getEmailProviderAdapter(integration.provider).validateSendInput({
      from: formatFrom(integration.default_from_email, integration.default_from_name),
      to: "delivered+licenkit-validation@resend.dev",
      ...(integration.reply_to_email ? { replyTo: integration.reply_to_email } : {}),
      templateRef: input.providerTemplateRef,
      variables: Object.fromEntries(
        contract.variables.map((descriptor) => [descriptor.name, descriptor.example]),
      ),
    });
    let existing: EmailTemplateBindingRow | undefined;
    try {
      existing = await requireBinding(c, integrationId, notificationType);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    const now = new Date().toISOString();
    if (!existing) {
      const bindingId = `etb_${ulid().toLowerCase()}`;
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO email_template_bindings (
             id, instance_id, email_integration_id, notification_type,
             contract_version, provider_template_ref, status, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)`,
        ).bind(
          bindingId,
          instanceId,
          integrationId,
          notificationType,
          input.contractVersion,
          input.providerTemplateRef,
          now,
        ),
        audit(c, {
          action: "admin.email_template_binding.created",
          resourceType: "email_template_binding",
          resourceId: bindingId,
          details: {
            integrationId,
            notificationType,
            contractVersion: input.contractVersion,
            providerTemplateRef: input.providerTemplateRef,
          },
          now,
        }),
      ]);
      return c.json({
        success: true,
        data: serializeBinding({
          id: bindingId,
          email_integration_id: integrationId,
          notification_type: notificationType,
          contract_version: input.contractVersion,
          provider_template_ref: input.providerTemplateRef,
          status: "active",
          created_at: now,
          updated_at: now,
        }),
      }, 201);
    }
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE email_template_bindings
         SET contract_version = ?1, provider_template_ref = ?2, updated_at = ?3
         WHERE instance_id = ?4 AND email_integration_id = ?5 AND id = ?6`,
      ).bind(
        input.contractVersion,
        input.providerTemplateRef,
        now,
        instanceId,
        integrationId,
        existing.id,
      ),
      audit(c, {
        action: "admin.email_template_binding.updated",
        resourceType: "email_template_binding",
        resourceId: existing.id,
        details: {
          integrationId,
          notificationType,
          contractVersion: input.contractVersion,
          providerTemplateRef: input.providerTemplateRef,
        },
        now,
      }),
    ]);
    return c.json({
      success: true,
      data: serializeBinding({
        ...existing,
        contract_version: input.contractVersion,
        provider_template_ref: input.providerTemplateRef,
        updated_at: now,
      }),
    });
  },
);

for (const action of ["disable", "enable"] as const) {
  adminEmailIntegrationsRouter.post(
    `/:integrationId/template-bindings/:notificationType/${action}`,
    ...mutationGuards(),
    async (c) => {
      const integrationId = c.req.param("integrationId");
      const notificationType = c.req.param("notificationType");
      await requireIntegration(c, integrationId);
      const existing = await requireBinding(c, integrationId, notificationType);
      const status = action === "enable" ? "active" : "disabled";
      if (existing.status === status) {
        return c.json({ success: true, data: { id: existing.id, status } });
      }
      const now = new Date().toISOString();
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE email_template_bindings SET status = ?1, updated_at = ?2
           WHERE instance_id = ?3 AND email_integration_id = ?4 AND id = ?5`,
        ).bind(status, now, c.get("instanceId")!, integrationId, existing.id),
        audit(c, {
          action: `admin.email_template_binding.${action}d`,
          resourceType: "email_template_binding",
          resourceId: existing.id,
          details: { integrationId, notificationType },
          now,
        }),
      ]);
      return c.json({ success: true, data: { id: existing.id, status } });
    },
  );
}

adminEmailIntegrationsRouter.post(
  "/:integrationId/template-bindings/:notificationType/test",
  ...mutationGuards(),
  async (c) => {
    const input = EmailConfigurationTestSchema.parse(await c.req.json());
    const integrationId = c.req.param("integrationId");
    const notificationType = c.req.param("notificationType");
    await requireIntegration(c, integrationId);
    const binding = await requireBinding(c, integrationId, notificationType);
    const result = await testEmailConfiguration({
      db: c.env.DB,
      env: c.env,
      instanceId: c.get("instanceId")!,
      emailIntegrationId: integrationId,
      notificationType,
      contractVersion: binding.contract_version,
      recipientEmail: input.recipientEmail,
      adminOrigin: new URL(c.req.url).origin,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: toSnakeCaseJson(result) });
  },
);

adminEmailIntegrationsRouter.post(
  "/:integrationId/template-bindings/:notificationType/retry-waiting",
  ...mutationGuards(),
  async (c) => {
    const integrationId = c.req.param("integrationId");
    const notificationType = c.req.param("notificationType");
    const integration = await requireIntegration(c, integrationId);
    const binding = await requireBinding(c, integrationId, notificationType);
    if (integration.status !== "active" || binding.status !== "active") {
      throw new ConflictError(
        "EMAIL_CONFIGURATION_NOT_ACTIVE",
        "The Email Integration and Template Binding must both be active before waiting Deliveries can be retried.",
      );
    }
    const now = new Date().toISOString();
    const result = await c.env.DB.prepare(
      `UPDATE email_deliveries
       SET status = 'pending', next_attempt_at = ?1, last_error_json = NULL,
           updated_at = ?1
       WHERE instance_id = ?2
         AND notification_type = ?3
         AND status = 'waiting_configuration'
         AND variables_ciphertext IS NOT NULL
         AND (send_expires_at IS NULL OR send_expires_at > ?1)`,
    ).bind(
      now,
      c.get("instanceId")!,
      notificationType,
    ).run();
    return c.json({
      success: true,
      data: { queued_count: Number(result.meta?.changes ?? 0) },
    });
  },
);

export const adminEmailDeliveriesRouter = new Hono<AppContext>();

adminEmailDeliveriesRouter.get("/", requireRole([...READ_ROLES]), async (c) => {
  const status = c.req.query("status");
  const result = status
    ? await c.env.DB.prepare(
      `SELECT id, recipient_type, customer_id, notification_type, contract_version,
              recipient_email, send_expires_at, variables_expires_at, status, attempt_count,
              next_attempt_at, provider_message_id, last_error_json,
              accepted_at, created_at, updated_at
       FROM email_deliveries
       WHERE instance_id = ?1 AND status = ?2
       ORDER BY created_at DESC, id DESC LIMIT 100`,
    ).bind(c.get("instanceId")!, status).all<EmailDeliveryRow>()
    : await c.env.DB.prepare(
      `SELECT id, recipient_type, customer_id, notification_type, contract_version,
              recipient_email, send_expires_at, variables_expires_at, status, attempt_count,
              next_attempt_at, provider_message_id, last_error_json,
              accepted_at, created_at, updated_at
       FROM email_deliveries
       WHERE instance_id = ?1
       ORDER BY created_at DESC, id DESC LIMIT 100`,
    ).bind(c.get("instanceId")!).all<EmailDeliveryRow>();
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: { items: result.results.map(serializeDelivery) } });
});

adminEmailDeliveriesRouter.get(
  "/:deliveryId",
  requireRole([...READ_ROLES]),
  async (c) => {
    const row = await one<EmailDeliveryRow>(c.env.DB.prepare(
      `SELECT id, recipient_type, customer_id, notification_type, contract_version,
              recipient_email, send_expires_at, variables_expires_at, status, attempt_count,
              next_attempt_at, provider_message_id, last_error_json,
              accepted_at, created_at, updated_at
       FROM email_deliveries
       WHERE instance_id = ?1 AND id = ?2 LIMIT 1`,
    ).bind(c.get("instanceId")!, c.req.param("deliveryId")));
    if (!row) throw new NotFoundError("Email Delivery not found");
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: serializeDelivery(row) });
  },
);

adminEmailDeliveriesRouter.post(
  "/:deliveryId/retry",
  ...mutationGuards(),
  async (c) => {
    const input = ManualRetrySchema.parse(await c.req.json());
    const instanceId = c.get("instanceId")!;
    const deliveryId = c.req.param("deliveryId");
    const row = await one<EmailDeliveryRow>(c.env.DB.prepare(
      `SELECT id, recipient_type, customer_id, notification_type, contract_version,
              recipient_email, send_expires_at, variables_expires_at, status, attempt_count,
              next_attempt_at, provider_message_id, last_error_json,
              accepted_at, created_at, updated_at
       FROM email_deliveries
       WHERE instance_id = ?1 AND id = ?2 LIMIT 1`,
    ).bind(instanceId, deliveryId));
    if (!row) throw new NotFoundError("Email Delivery not found");
    if (row.status === "accepted" || row.status === "expired" || row.status === "cancelled") {
      throw new ConflictError(
        "EMAIL_DELIVERY_NOT_RETRYABLE",
        "Accepted, expired, or cancelled email Deliveries cannot be resent.",
      );
    }
    if (row.send_expires_at && Date.parse(row.send_expires_at) <= Date.now()) {
      throw new ConflictError(
        "EMAIL_DELIVERY_SEND_EXPIRED",
        "The email content has expired and cannot be resent.",
      );
    }
    const lastError = parseLastError(row.last_error_json);
    const possibleDuplicate = lastError?.possible_duplicate_on_resend === true;
    if (possibleDuplicate && input.confirmPossibleDuplicate !== true) {
      throw new AppError(
        "EMAIL_DELIVERY_POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED",
        "The previous Provider result is unknown. Confirm the possible duplicate before resending.",
        409,
      );
    }
    const dispatch = await dispatchDelivery({
      db: c.env.DB,
      env: c.env,
      instanceId,
      deliveryId,
      manual: true,
    });
    if (!dispatch.claimed) {
      throw new ConflictError(
        "EMAIL_DELIVERY_NOT_CLAIMED",
        "The email Delivery is already being processed or is no longer retryable.",
      );
    }
    const updated = await one<EmailDeliveryRow>(c.env.DB.prepare(
      `SELECT id, recipient_type, customer_id, notification_type, contract_version,
              recipient_email, send_expires_at, variables_expires_at, status, attempt_count,
              next_attempt_at, provider_message_id, last_error_json,
              accepted_at, created_at, updated_at
       FROM email_deliveries
       WHERE instance_id = ?1 AND id = ?2 LIMIT 1`,
    ).bind(instanceId, deliveryId));
    return c.json({ success: true, data: serializeDelivery(updated!) });
  },
);

adminEmailDeliveriesRouter.post(
  "/:deliveryId/cancel",
  ...mutationGuards(),
  async (c) => {
    const instanceId = c.get("instanceId")!;
    const deliveryId = c.req.param("deliveryId");
    const now = new Date().toISOString();
    const diagnostic = JSON.stringify({
      outcome: "cancelled_by_admin",
      source: "licenkit",
      code: "EMAIL_DELIVERY_CANCELLED",
      message: "The email Delivery was cancelled by an administrator.",
    });
    const cancelledResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE email_deliveries
         SET status = 'cancelled', variables_ciphertext = NULL,
             variables_expires_at = NULL, next_attempt_at = NULL,
             locked_by = NULL, locked_until = NULL,
             last_error_json = ?1, updated_at = ?2
         WHERE instance_id = ?3 AND id = ?4
           AND status IN ('pending', 'retry_scheduled', 'waiting_configuration', 'failed')`,
      ).bind(diagnostic, now, instanceId, deliveryId),
      c.env.DB.prepare(
        `UPDATE billing_checkout_verifications
         SET status = 'cancelled', completed_at = NULL,
             last_error_code = 'EMAIL_DELIVERY_CANCELLED',
             last_error_detail = 'The related email was cancelled by an administrator.',
             updated_at = ?1
         WHERE instance_id = ?2 AND delivery_id = ?3
           AND status = 'delivery_pending'
           AND EXISTS (
             SELECT 1 FROM email_deliveries AS delivery
             WHERE delivery.instance_id = ?2 AND delivery.id = ?3
               AND delivery.status = 'cancelled' AND delivery.updated_at = ?1
           )`,
      ).bind(now, instanceId, deliveryId),
    ]);
    if (Number(cancelledResults[0]?.meta?.changes ?? 0) !== 1) {
      throw new ConflictError(
        "EMAIL_DELIVERY_NOT_CANCELLABLE",
        "Only an unsent email Delivery that is not currently processing can be cancelled.",
      );
    }
    await c.env.DB.batch([
      audit(c, {
        action: "email.delivery.cancel",
        resourceType: "email_delivery",
        resourceId: deliveryId,
        now,
      }),
    ]);
    const updated = await one<EmailDeliveryRow>(c.env.DB.prepare(
      `SELECT id, recipient_type, customer_id, notification_type, contract_version,
              recipient_email, send_expires_at, variables_expires_at,
              status, attempt_count, next_attempt_at, provider_message_id,
              last_error_json, accepted_at, created_at, updated_at
       FROM email_deliveries
       WHERE instance_id = ?1 AND id = ?2 LIMIT 1`,
    ).bind(instanceId, deliveryId));
    return c.json({ success: true, data: serializeDelivery(updated!) });
  },
);
