import { ulid } from "ulid";
import { PaddleHttpError, BillingProcessingError } from "../../infra/billing/errors";
import { createPaddleCustomerPortalSession, probePaddleCustomerRead } from "../../infra/billing/paddle";
import type { BillingProviderRecord, ProviderHttpErrorDetails } from "../../infra/billing/types";
import { serializeBillingDiagnostic } from "../../infra/billing/redaction";
import { AppError, NotFoundError } from "../../middleware/error";

export type SystemIssueCapability = "customer_read" | "customer_portal_session";

interface SystemIssueRow {
  id: string;
  account_id: string;
  billing_provider_id: string;
  capability: SystemIssueCapability;
  issue_code: string;
  severity: "warning" | "error" | "critical";
  status: "open" | "resolved";
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  last_error_detail_json: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
  provider: string;
  environment: "sandbox" | "live";
  client_side_token: string;
  webhook_secret_ciphertext: string;
  api_secret_ciphertext: string | null;
  provider_status: "active" | "disabled";
  provider_created_at: string;
  provider_updated_at: string;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function changes(result: D1Result<unknown> | undefined): number {
  return result?.meta?.changes ?? 0;
}

function diagnostic(details: ProviderHttpErrorDetails): Record<string, unknown> {
  return {
    provider: details.provider,
    operation: details.operation.slice(0, 128),
    httpStatus: details.httpStatus,
    providerCode: details.providerCode?.slice(0, 255) ?? null,
    requestId: details.requestId?.slice(0, 255) ?? null,
    retryAfter: details.retryAfter?.slice(0, 255) ?? null,
    message: details.message.slice(0, 2_000),
  };
}

function providerFromIssue(row: SystemIssueRow): BillingProviderRecord {
  if (row.provider !== "paddle") {
    throw new AppError(
      "SYSTEM_ISSUE_PROVIDER_UNSUPPORTED",
      "The System Issue Provider is not supported.",
      409,
      { issueId: row.id, provider: row.provider },
    );
  }
  return {
    id: row.billing_provider_id,
    account_id: row.account_id,
    provider: "paddle",
    environment: row.environment,
    client_side_token: row.client_side_token,
    webhook_secret_ciphertext: row.webhook_secret_ciphertext,
    api_secret_ciphertext: row.api_secret_ciphertext,
    status: row.provider_status,
    created_at: row.provider_created_at,
    updated_at: row.provider_updated_at,
  };
}

function issueSelect(): string {
  return `SELECT issue.id, issue.account_id, issue.billing_provider_id,
                 issue.capability, issue.issue_code, issue.severity, issue.status,
                 issue.occurrence_count, issue.first_seen_at, issue.last_seen_at,
                 issue.last_error_detail_json, issue.resolved_at,
                 issue.resolved_by_user_id, issue.resolution_note,
                 issue.created_at, issue.updated_at,
                 provider.provider, provider.environment, provider.client_side_token,
                 provider.webhook_secret_ciphertext, provider.api_secret_ciphertext,
                 provider.status AS provider_status,
                 provider.created_at AS provider_created_at,
                 provider.updated_at AS provider_updated_at
          FROM system_issues AS issue
          JOIN billing_providers AS provider
            ON provider.account_id = issue.account_id
           AND provider.id = issue.billing_provider_id`;
}

async function getIssue(
  db: D1Database,
  accountId: string,
  issueId: string,
): Promise<SystemIssueRow | null> {
  const row = await db.prepare(
    `${issueSelect()}
     WHERE issue.account_id = ?1 AND issue.id = ?2
     LIMIT 1`,
  ).bind(accountId, issueId).first<SystemIssueRow>();
  return row ?? null;
}

function issueUpsertStatement(input: {
  db: D1Database;
  issueId: string;
  accountId: string;
  billingProviderId: string;
  capability: SystemIssueCapability;
  issueCode: string;
  detailJson: string;
  nowIso: string;
}): D1PreparedStatement {
  return input.db.prepare(
    `INSERT INTO system_issues (
       id, account_id, billing_provider_id, capability, issue_code,
       severity, status, occurrence_count, first_seen_at, last_seen_at,
       last_error_detail_json, resolved_at, resolved_by_user_id,
       resolution_note, created_at, updated_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, 'error', 'open', 1, ?6, ?6, ?7,
       NULL, NULL, NULL, ?6, ?6
     )
     ON CONFLICT(account_id, billing_provider_id, capability, issue_code) DO UPDATE SET
       severity = excluded.severity,
       status = 'open',
       occurrence_count = system_issues.occurrence_count + 1,
       last_seen_at = excluded.last_seen_at,
       last_error_detail_json = excluded.last_error_detail_json,
       resolved_at = NULL,
       resolved_by_user_id = NULL,
       resolution_note = NULL,
       updated_at = excluded.updated_at`,
  ).bind(
    input.issueId,
    input.accountId,
    input.billingProviderId,
    input.capability,
    input.issueCode,
    input.nowIso,
    input.detailJson,
  );
}

async function findIssueId(input: {
  db: D1Database;
  accountId: string;
  billingProviderId: string;
  capability: SystemIssueCapability;
  issueCode: string;
}): Promise<string> {
  const row = await input.db.prepare(
    `SELECT id FROM system_issues
     WHERE account_id = ?1 AND billing_provider_id = ?2
       AND capability = ?3 AND issue_code = ?4
     LIMIT 1`,
  ).bind(
    input.accountId,
    input.billingProviderId,
    input.capability,
    input.issueCode,
  ).first<{ id: string }>();
  if (!row) throw new Error("System Issue upsert did not persist.");
  return row.id;
}

export async function recordProviderSystemIssue(input: {
  db: D1Database;
  accountId: string;
  billingProviderId: string;
  capability: SystemIssueCapability;
  issueCode: string;
  providerError: ProviderHttpErrorDetails;
  now?: Date;
}): Promise<{ issueId: string }> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const proposedId = `siy_${ulid().toLowerCase()}`;
  await input.db.batch([
    issueUpsertStatement({
      ...input,
      issueId: proposedId,
      detailJson: serializeBillingDiagnostic(diagnostic(input.providerError)),
      nowIso,
    }),
  ]);
  return {
    issueId: await findIssueId(input),
  };
}

/**
 * Persists the Provider-level issue, permanent Issue/Event relation, and the
 * event's current blocking reference in one D1 batch.
 */
export async function blockInboundEventForProviderAuthIssue(input: {
  db: D1Database;
  accountId: string;
  billingProviderId: string;
  inboundEventId: string;
  workerId: string;
  providerError: ProviderHttpErrorDetails;
  now?: Date;
}): Promise<{ issueId: string }> {
  const capability: SystemIssueCapability = "customer_read";
  const issueCode = "BILLING_PROVIDER_API_AUTH_INVALID";
  const nowIso = (input.now ?? new Date()).toISOString();
  const proposedId = `siy_${ulid().toLowerCase()}`;
  const detailJson = serializeBillingDiagnostic(diagnostic(input.providerError));
  await input.db.batch([
    issueUpsertStatement({
      db: input.db,
      issueId: proposedId,
      accountId: input.accountId,
      billingProviderId: input.billingProviderId,
      capability,
      issueCode,
      detailJson,
      nowIso,
    }),
    input.db.prepare(
      `INSERT INTO system_issue_inbound_events (
         account_id, system_issue_id, inbound_event_id,
         occurrence_count, first_seen_at, last_seen_at
       )
       SELECT ?1, issue.id, ?2, 1, ?3, ?3
       FROM system_issues AS issue
       WHERE issue.account_id = ?1 AND issue.billing_provider_id = ?4
         AND issue.capability = 'customer_read' AND issue.issue_code = ?5
       ON CONFLICT(system_issue_id, inbound_event_id) DO UPDATE SET
         occurrence_count = system_issue_inbound_events.occurrence_count + 1,
         last_seen_at = excluded.last_seen_at`,
    ).bind(input.accountId, input.inboundEventId, nowIso, input.billingProviderId, issueCode),
    input.db.prepare(
      `UPDATE inbound_events
       SET status = 'pending', next_attempt_at = NULL,
           locked_by = NULL, locked_until = NULL,
           last_error_code = ?1, last_error_detail = ?2,
           blocking_system_issue_id = (
             SELECT issue.id FROM system_issues AS issue
             WHERE issue.account_id = ?3 AND issue.billing_provider_id = ?4
               AND issue.capability = 'customer_read' AND issue.issue_code = ?1
             LIMIT 1
           ),
           updated_at = ?5
       WHERE account_id = ?3 AND id = ?6
         AND status = 'processing' AND locked_by = ?7`,
    ).bind(
      issueCode,
      detailJson,
      input.accountId,
      input.billingProviderId,
      nowIso,
      input.inboundEventId,
      input.workerId,
    ),
  ]);
  return {
    issueId: await findIssueId({
      db: input.db,
      accountId: input.accountId,
      billingProviderId: input.billingProviderId,
      capability,
      issueCode,
    }),
  };
}

export async function listSystemIssues(input: {
  db: D1Database;
  accountId: string;
  now?: Date;
}): Promise<{ items: Array<Record<string, unknown>> }> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const result = await input.db.prepare(
    `SELECT issue.id, issue.billing_provider_id, provider.provider, provider.environment,
            issue.capability, issue.issue_code, issue.severity, issue.status,
            issue.occurrence_count, issue.first_seen_at, issue.last_seen_at,
            issue.last_error_detail_json, issue.resolved_at,
            issue.resolved_by_user_id, issue.resolution_note, issue.updated_at,
            (SELECT COUNT(*) FROM system_issue_inbound_events AS relation
              WHERE relation.account_id = issue.account_id
                AND relation.system_issue_id = issue.id) AS affected_event_count,
            (SELECT COUNT(*) FROM inbound_events AS event
              WHERE event.account_id = issue.account_id
                AND event.blocking_system_issue_id = issue.id) AS blocked_event_count,
            (SELECT COUNT(*) FROM inbound_events AS event
              WHERE event.account_id = issue.account_id
                AND event.blocking_system_issue_id = issue.id
                AND event.status = 'pending'
                AND event.last_error_code = issue.issue_code
                AND event.payload_ciphertext IS NOT NULL
                AND event.payload_expires_at > ?2
                AND event.result_type IS NULL
                AND event.result_reference_id IS NULL) AS retryable_event_count
     FROM system_issues AS issue
     JOIN billing_providers AS provider
       ON provider.account_id = issue.account_id
      AND provider.id = issue.billing_provider_id
     WHERE issue.account_id = ?1
     ORDER BY CASE issue.status WHEN 'open' THEN 0 ELSE 1 END,
              CASE issue.severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,
              issue.last_seen_at DESC, issue.id
     LIMIT 200`,
  ).bind(input.accountId, nowIso).all<Record<string, any>>();
  return {
    items: result.results.map((row) => ({
      id: row.id,
      billingProviderId: row.billing_provider_id,
      provider: row.provider,
      environment: row.environment,
      capability: row.capability,
      issueCode: row.issue_code,
      severity: row.severity,
      status: row.status,
      occurrenceCount: row.occurrence_count,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastError: parseJsonObject(row.last_error_detail_json),
      resolvedAt: row.resolved_at,
      resolvedByUserId: row.resolved_by_user_id,
      resolutionNote: row.resolution_note,
      updatedAt: row.updated_at,
      recoveryPreview: {
        affectedEventCount: row.affected_event_count,
        blockedEventCount: row.blocked_event_count,
        retryableEventCount: row.retryable_event_count,
      },
    })),
  };
}

export async function getSystemIssueDetail(input: {
  db: D1Database;
  accountId: string;
  issueId: string;
  now?: Date;
}): Promise<Record<string, unknown>> {
  const issue = await getIssue(input.db, input.accountId, input.issueId);
  if (!issue) throw new NotFoundError("System Issue not found.");
  const nowIso = (input.now ?? new Date()).toISOString();
  const events = await input.db.prepare(
    `SELECT relation.inbound_event_id, relation.occurrence_count,
            relation.first_seen_at, relation.last_seen_at,
            event.external_event_id, event.external_event_type,
            event.external_customer_id, event.external_transaction_id,
            event.status, event.last_error_code, event.last_error_detail,
            event.blocking_system_issue_id, event.payload_ciphertext,
            event.payload_expires_at, event.result_type,
            event.result_reference_id, event.received_at, event.updated_at
     FROM system_issue_inbound_events AS relation
     JOIN inbound_events AS event
       ON event.account_id = relation.account_id
      AND event.id = relation.inbound_event_id
     WHERE relation.account_id = ?1 AND relation.system_issue_id = ?2
     ORDER BY relation.last_seen_at DESC, relation.inbound_event_id
     LIMIT 500`,
  ).bind(input.accountId, input.issueId).all<Record<string, any>>();
  const items = events.results.map((row) => {
    const isBlocked = row.blocking_system_issue_id === issue.id;
    const retryable = isBlocked && row.status === "pending" &&
      row.last_error_code === issue.issue_code && Boolean(row.payload_ciphertext) &&
      row.payload_expires_at > nowIso && row.result_type === null && row.result_reference_id === null;
    let skipReason: string | null = null;
    if (!retryable) {
      if (!isBlocked) skipReason = "NOT_CURRENTLY_BLOCKED_BY_ISSUE";
      else if (row.status !== "pending") skipReason = "EVENT_STATUS_CHANGED";
      else if (row.last_error_code !== issue.issue_code) skipReason = "EVENT_ERROR_CHANGED";
      else if (!row.payload_ciphertext || row.payload_expires_at <= nowIso) skipReason = "EVENT_PAYLOAD_EXPIRED";
      else skipReason = "EVENT_RESULT_ALREADY_EXISTS";
    }
    return {
      id: row.inbound_event_id,
      externalEventId: row.external_event_id,
      eventType: row.external_event_type,
      externalCustomerId: row.external_customer_id,
      externalTransactionId: row.external_transaction_id,
      status: row.status,
      lastErrorCode: row.last_error_code,
      lastError: row.last_error_detail ? parseJsonObject(row.last_error_detail) : null,
      currentlyBlocked: isBlocked,
      retryable,
      skipReason,
      resultType: row.result_type,
      resultReferenceId: row.result_reference_id,
      occurrenceCount: row.occurrence_count,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      receivedAt: row.received_at,
      updatedAt: row.updated_at,
    };
  });
  const preview = await input.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM system_issue_inbound_events AS relation
         WHERE relation.account_id = ?1 AND relation.system_issue_id = ?2) AS affected_event_count,
       (SELECT COUNT(*) FROM inbound_events AS event
         WHERE event.account_id = ?1 AND event.blocking_system_issue_id = ?2) AS blocked_event_count,
       (SELECT COUNT(*) FROM inbound_events AS event
         WHERE event.account_id = ?1 AND event.blocking_system_issue_id = ?2
           AND event.status = 'pending' AND event.last_error_code = ?3
           AND event.payload_ciphertext IS NOT NULL AND event.payload_expires_at > ?4
           AND event.result_type IS NULL AND event.result_reference_id IS NULL) AS retryable_event_count`,
  ).bind(input.accountId, input.issueId, issue.issue_code, nowIso).first<{
    affected_event_count: number;
    blocked_event_count: number;
    retryable_event_count: number;
  }>();
  const affectedEventCount = preview?.affected_event_count ?? 0;
  return {
    id: issue.id,
    billingProviderId: issue.billing_provider_id,
    provider: issue.provider,
    environment: issue.environment,
    capability: issue.capability,
    issueCode: issue.issue_code,
    severity: issue.severity,
    status: issue.status,
    occurrenceCount: issue.occurrence_count,
    firstSeenAt: issue.first_seen_at,
    lastSeenAt: issue.last_seen_at,
    lastError: parseJsonObject(issue.last_error_detail_json),
    resolvedAt: issue.resolved_at,
    resolvedByUserId: issue.resolved_by_user_id,
    resolutionNote: issue.resolution_note,
    updatedAt: issue.updated_at,
    recoveryPreview: {
      affectedEventCount,
      blockedEventCount: preview?.blocked_event_count ?? 0,
      retryableEventCount: preview?.retryable_event_count ?? 0,
    },
    affectedEvents: items,
    affectedEventsTruncated: affectedEventCount > items.length,
  };
}

function prepareResolutionAudit(input: {
  db: D1Database;
  accountId: string;
  issueId: string;
  userId: string;
  requestId?: string | null;
  retryAffectedEvents: boolean;
  markerUpdatedAt: string;
  markerResolutionNote: string;
  ip?: string | null;
  userAgent?: string | null;
}): D1PreparedStatement {
  return input.db.prepare(
    `INSERT INTO audit_logs (
       id, account_id, actor_type, actor_user_id, actor_customer_id,
       action, resource_type, resource_id, request_id,
       details_redacted_json, ip, user_agent, created_at
     )
     SELECT ?1, ?2, 'user', ?3, NULL,
            'system_issue.resolve', 'system_issue', ?4, ?5,
            ?6, ?7, ?8, ?9
     FROM system_issues AS issue
     WHERE issue.account_id = ?2 AND issue.id = ?4
       AND issue.status = 'resolved' AND issue.updated_at = ?9
       AND issue.resolved_by_user_id = ?3 AND issue.resolution_note = ?10`,
  ).bind(
    `aud_${ulid().toLowerCase()}`,
    input.accountId,
    input.userId,
    input.issueId,
    input.requestId ?? null,
    serializeBillingDiagnostic({ retryAffectedEvents: input.retryAffectedEvents }),
    input.ip ?? null,
    input.userAgent?.slice(0, 512) ?? null,
    input.markerUpdatedAt,
    input.markerResolutionNote,
  );
}

export async function resolveSystemIssue(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string; STORAGE_ENCRYPTION_KEY_ID?: string };
  accountId: string;
  issueId: string;
  userId: string;
  resolutionNote: string;
  retryAffectedEvents: boolean;
  expectedUpdatedAt: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<Record<string, unknown>> {
  const issue = await getIssue(input.db, input.accountId, input.issueId);
  if (!issue) throw new NotFoundError("System Issue not found.");
  if (issue.updated_at !== input.expectedUpdatedAt || issue.status !== "open") {
    throw new AppError(
      "SYSTEM_ISSUE_STALE",
      "System Issue changed after it was loaded.",
      409,
      { issueId: issue.id, status: issue.status, updatedAt: issue.updated_at },
    );
  }
  if (issue.issue_code !== "BILLING_PROVIDER_API_AUTH_INVALID") {
    throw new AppError(
      "SYSTEM_ISSUE_RESOLUTION_UNSUPPORTED",
      "This System Issue does not have an automated verification strategy.",
      409,
      { issueId: issue.id, capability: issue.capability, issueCode: issue.issue_code },
    );
  }
  if (issue.capability === "customer_portal_session" && input.retryAffectedEvents) {
    throw new AppError(
      "SYSTEM_ISSUE_RETRY_NOT_APPLICABLE",
      "Customer portal requests are short-lived and must be initiated again by the Customer.",
      409,
      { issueId: issue.id, capability: issue.capability },
    );
  }

  try {
    const provider = providerFromIssue(issue);
    if (issue.capability === "customer_read") {
      await probePaddleCustomerRead(provider, input.env, input.fetchImpl);
    } else {
      const context = await input.db.prepare(
        `SELECT subscription.external_customer_id, subscription.external_subscription_id
         FROM billing_subscriptions AS subscription
         JOIN billing_customers AS customer
           ON customer.account_id = subscription.account_id
          AND customer.billing_provider_id = subscription.billing_provider_id
          AND customer.external_customer_id = subscription.external_customer_id
         JOIN licenses AS license
           ON license.account_id = subscription.account_id
          AND license.id = subscription.license_id
         WHERE subscription.account_id = ?1
           AND subscription.billing_provider_id = ?2
           AND customer.link_status = 'linked' AND customer.provider_status = 'active'
           AND license.renewal_mode = 'billing'
         ORDER BY subscription.updated_at DESC, subscription.id
         LIMIT 1`,
      ).bind(issue.account_id, issue.billing_provider_id).first<{
        external_customer_id: string;
        external_subscription_id: string;
      }>();
      if (!context) {
        throw new AppError(
          "SYSTEM_ISSUE_VERIFICATION_CONTEXT_MISSING",
          "No linked Billing Subscription is available to verify the customer portal capability.",
          409,
          { issueId: issue.id, capability: issue.capability },
        );
      }
      // The resulting URL is deliberately discarded. This proves only the
      // configured capability; the original Customer request is never replayed.
      await createPaddleCustomerPortalSession(
        provider,
        context.external_customer_id,
        context.external_subscription_id,
        input.env,
        input.fetchImpl,
        input.now,
      );
    }
  } catch (error) {
    if (error instanceof PaddleHttpError && error.code === "BILLING_PROVIDER_API_AUTH_INVALID") {
      await recordProviderSystemIssue({
        db: input.db,
        accountId: issue.account_id,
        billingProviderId: issue.billing_provider_id,
        capability: issue.capability,
        issueCode: issue.issue_code,
        providerError: error.providerDetails,
        now: input.now,
      });
      throw new AppError(
        "SYSTEM_ISSUE_VERIFICATION_FAILED",
        `Paddle ${issue.capability} is still unauthorized.`,
        409,
        {
          issueId: issue.id,
          capability: issue.capability,
          httpStatus: error.providerDetails.httpStatus,
          providerCode: error.providerDetails.providerCode,
          requestId: error.providerDetails.requestId,
        },
        { provider: diagnostic(error.providerDetails) },
      );
    }
    if (error instanceof PaddleHttpError) {
      throw new AppError(
        "SYSTEM_ISSUE_VERIFICATION_TEMPORARILY_UNAVAILABLE",
        `Paddle ${issue.capability} could not be verified yet.`,
        503,
        {
          issueId: issue.id,
          capability: issue.capability,
          httpStatus: error.providerDetails.httpStatus,
          providerCode: error.providerDetails.providerCode,
          requestId: error.providerDetails.requestId,
          retryAfter: error.providerDetails.retryAfter,
        },
        { provider: diagnostic(error.providerDetails) },
      );
    }
    if (error instanceof BillingProcessingError) {
      throw new AppError(error.code, error.message, 409, error.details);
    }
    throw error;
  }

  const nowIso = (input.now ?? new Date()).toISOString();
  const statements: D1PreparedStatement[] = [
    input.db.prepare(
      `UPDATE system_issues
       SET status = 'resolved', resolved_at = ?1, resolved_by_user_id = ?2,
           resolution_note = ?3, updated_at = ?1
       WHERE account_id = ?4 AND id = ?5 AND status = 'open'
         AND updated_at = ?6 AND occurrence_count = ?7`,
    ).bind(
      nowIso,
      input.userId,
      input.resolutionNote,
      input.accountId,
      input.issueId,
      input.expectedUpdatedAt,
      issue.occurrence_count,
    ),
  ];
  if (input.retryAffectedEvents) {
    statements.push(input.db.prepare(
      `UPDATE inbound_events
       SET blocking_system_issue_id = NULL, next_attempt_at = ?1,
           locked_by = NULL, locked_until = NULL, updated_at = ?1
       WHERE account_id = ?2 AND blocking_system_issue_id = ?3
         AND status = 'pending' AND last_error_code = ?4
         AND payload_ciphertext IS NOT NULL AND payload_expires_at > ?1
         AND result_type IS NULL AND result_reference_id IS NULL
         AND EXISTS (
           SELECT 1 FROM system_issues AS issue
           WHERE issue.account_id = ?2 AND issue.id = ?3
             AND issue.status = 'resolved' AND issue.updated_at = ?1
             AND issue.resolved_by_user_id = ?5 AND issue.resolution_note = ?6
         )`,
    ).bind(
      nowIso,
      input.accountId,
      input.issueId,
      issue.issue_code,
      input.userId,
      input.resolutionNote,
    ));
  }
  statements.push(prepareResolutionAudit({
    db: input.db,
    accountId: input.accountId,
    issueId: input.issueId,
    userId: input.userId,
    requestId: input.requestId,
    retryAffectedEvents: input.retryAffectedEvents,
    markerUpdatedAt: nowIso,
    markerResolutionNote: input.resolutionNote,
    ip: input.ip,
    userAgent: input.userAgent,
  }));
  const results = await input.db.batch(statements);
  const resolved = await getIssue(input.db, input.accountId, input.issueId);
  if (!resolved || resolved.status !== "resolved" || resolved.updated_at !== nowIso ||
      resolved.resolved_by_user_id !== input.userId || resolved.resolution_note !== input.resolutionNote) {
    throw new AppError(
      "SYSTEM_ISSUE_STALE",
      "System Issue changed before the resolution could be applied.",
      409,
      { issueId: input.issueId },
    );
  }
  const retryResultIndex = input.retryAffectedEvents ? 1 : -1;
  const retriedEventCount = retryResultIndex >= 0 ? changes(results[retryResultIndex]) : 0;
  const relationCount = await input.db.prepare(
    `SELECT COUNT(*) AS count
     FROM system_issue_inbound_events
     WHERE account_id = ?1 AND system_issue_id = ?2`,
  ).bind(input.accountId, input.issueId).first<{ count: number }>();
  return {
    id: resolved.id,
    status: resolved.status,
    resolvedAt: resolved.resolved_at,
    retryAffectedEvents: input.retryAffectedEvents,
    retriedEventCount,
    skippedAffectedEventCount: Math.max(0, (relationCount?.count ?? 0) - retriedEventCount),
  };
}

/**
 * Requeues events that remain blocked by an already resolved customer.read
 * issue. This is deliberately separate from resolving the shared issue: an
 * administrator may defer event recovery, and a later verified Paddle replay
 * may restore an event payload that was expired during the original resolve.
 */
export async function retryResolvedSystemIssueEvents(input: {
  db: D1Database;
  accountId: string;
  issueId: string;
  userId: string;
  expectedUpdatedAt: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}): Promise<Record<string, unknown>> {
  const issue = await getIssue(input.db, input.accountId, input.issueId);
  if (!issue) throw new NotFoundError("System Issue not found.");
  if (issue.status !== "resolved" || issue.updated_at !== input.expectedUpdatedAt) {
    throw new AppError(
      "SYSTEM_ISSUE_STALE",
      "System Issue changed after it was loaded.",
      409,
      { issueId: issue.id, status: issue.status, updatedAt: issue.updated_at },
    );
  }
  if (issue.issue_code !== "BILLING_PROVIDER_API_AUTH_INVALID" || issue.capability !== "customer_read") {
    throw new AppError(
      "SYSTEM_ISSUE_RETRY_NOT_APPLICABLE",
      "This System Issue does not have replayable Inbound Events.",
      409,
      { issueId: issue.id, capability: issue.capability, issueCode: issue.issue_code },
    );
  }

  const nowIso = (input.now ?? new Date()).toISOString();
  const results = await input.db.batch([
    input.db.prepare(
      `UPDATE inbound_events
       SET blocking_system_issue_id = NULL, next_attempt_at = ?1,
           locked_by = NULL, locked_until = NULL, updated_at = ?1
       WHERE account_id = ?2 AND blocking_system_issue_id = ?3
         AND status = 'pending' AND last_error_code = ?4
         AND payload_ciphertext IS NOT NULL AND payload_expires_at > ?1
         AND result_type IS NULL AND result_reference_id IS NULL
         AND EXISTS (
           SELECT 1 FROM system_issues AS issue
           WHERE issue.account_id = ?2 AND issue.id = ?3
             AND issue.status = 'resolved' AND issue.updated_at = ?5
             AND issue.capability = 'customer_read' AND issue.issue_code = ?4
         )`,
    ).bind(
      nowIso,
      input.accountId,
      input.issueId,
      issue.issue_code,
      input.expectedUpdatedAt,
    ),
    input.db.prepare(
      `INSERT INTO audit_logs (
         id, account_id, actor_type, actor_user_id, actor_customer_id,
         action, resource_type, resource_id, request_id,
         details_redacted_json, ip, user_agent, created_at
       )
       SELECT ?1, ?2, 'user', ?3, NULL,
              'system_issue.retry_affected_events', 'system_issue', ?4, ?5,
              ?6, ?7, ?8, ?9
       FROM system_issues AS issue
       WHERE issue.account_id = ?2 AND issue.id = ?4
         AND issue.status = 'resolved' AND issue.updated_at = ?10
         AND issue.capability = 'customer_read'
         AND issue.issue_code = 'BILLING_PROVIDER_API_AUTH_INVALID'`,
    ).bind(
      `aud_${ulid().toLowerCase()}`,
      input.accountId,
      input.userId,
      input.issueId,
      input.requestId ?? null,
      serializeBillingDiagnostic({ source: "resolved_system_issue" }),
      input.ip ?? null,
      input.userAgent?.slice(0, 512) ?? null,
      nowIso,
      input.expectedUpdatedAt,
    ),
  ]);
  if (changes(results[1]) !== 1) {
    throw new AppError(
      "SYSTEM_ISSUE_STALE",
      "System Issue changed before affected events could be retried.",
      409,
      { issueId: input.issueId },
    );
  }
  const retriedEventCount = changes(results[0]);
  const relationCount = await input.db.prepare(
    `SELECT COUNT(*) AS count
     FROM system_issue_inbound_events
     WHERE account_id = ?1 AND system_issue_id = ?2`,
  ).bind(input.accountId, input.issueId).first<{ count: number }>();
  return {
    id: issue.id,
    status: issue.status,
    retriedEventCount,
    skippedAffectedEventCount: Math.max(0, (relationCount?.count ?? 0) - retriedEventCount),
  };
}
