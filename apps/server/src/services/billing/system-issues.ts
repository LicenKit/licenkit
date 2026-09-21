import type { ProviderHttpErrorDetails } from "../../infra/billing/types";
import { serializeBillingDiagnostic } from "../../infra/billing/redaction";
import { prepareSystemIssueUpsert } from "../operations/system-issues";

export type BillingSystemIssueOperation = "customer_read" | "customer_portal_session";

function providerDiagnostic(details: ProviderHttpErrorDetails): Record<string, unknown> {
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

export async function recordProviderSystemIssue(input: {
  db: D1Database;
  accountId: string;
  billingProviderId: string;
  capability: BillingSystemIssueOperation;
  issueCode: string;
  providerError: ProviderHttpErrorDetails;
  now?: Date;
}): Promise<{ issueId: string }> {
  const nowIso = (input.now ?? new Date()).toISOString();
  await prepareSystemIssueUpsert({
    db: input.db,
    accountId: input.accountId,
    category: "billing",
    sourceType: "billing_provider",
    sourceId: input.billingProviderId,
    operation: input.capability,
    errorCode: input.issueCode,
    errorDetailJson: serializeBillingDiagnostic(providerDiagnostic(input.providerError)),
    nowIso,
  }).run();
  const issue = await input.db.prepare(
    `SELECT id FROM system_issues
     WHERE account_id = ?1 AND category = 'billing'
       AND source_type = 'billing_provider' AND source_id = ?2
       AND operation = ?3 AND error_code = ?4
     LIMIT 1`,
  ).bind(
    input.accountId,
    input.billingProviderId,
    input.capability,
    input.issueCode,
  ).first<{ id: string }>();
  if (!issue) throw new Error("System Issue upsert did not persist.");
  return { issueId: issue.id };
}

/**
 * Records a callback error signal while moving the owning Event into
 * needs_attention. The System Issue never controls Event scheduling or replay.
 */
export async function recordInboundEventProviderAuthIssue(input: {
  db: D1Database;
  accountId: string;
  billingProviderId: string;
  inboundEventId: string;
  workerId: string;
  issueCode: string;
  providerError: ProviderHttpErrorDetails;
  now?: Date;
}): Promise<void> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const detailJson = serializeBillingDiagnostic(providerDiagnostic(input.providerError));
  await input.db.batch([
    prepareSystemIssueUpsert({
      db: input.db,
      accountId: input.accountId,
      category: "webhook",
      sourceType: "billing_provider",
      sourceId: input.billingProviderId,
      operation: "customer_read",
      errorCode: input.issueCode,
      errorDetailJson: detailJson,
      nowIso,
    }),
    input.db.prepare(
      `UPDATE inbound_events
       SET status = 'needs_attention', next_attempt_at = NULL,
           locked_by = NULL, locked_until = NULL,
           last_error_code = ?1, last_error_detail = ?2,
           processed_at = ?3, updated_at = ?3
       WHERE account_id = ?4 AND id = ?5
         AND status = 'processing' AND locked_by = ?6`,
    ).bind(
      input.issueCode,
      detailJson,
      nowIso,
      input.accountId,
      input.inboundEventId,
      input.workerId,
    ),
  ]);
}
