import { ulid } from "ulid";

export type SystemIssueCategory = "billing" | "webhook" | "email";

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { raw: value };
  } catch {
    return { raw: value };
  }
}

export function prepareSystemIssueUpsert(input: {
  db: D1Database;
  accountId: string;
  category: SystemIssueCategory;
  sourceType: string;
  sourceId: string;
  operation: string;
  errorCode: string;
  errorDetailJson: string;
  nowIso: string;
}): D1PreparedStatement {
  return input.db.prepare(
    `INSERT INTO system_issues (
       id, account_id, category, source_type, source_id, operation,
       error_code, error_detail_json, occurrence_count, first_seen_at, last_seen_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)
     ON CONFLICT(account_id, category, source_type, source_id, operation, error_code)
     DO UPDATE SET
       occurrence_count = system_issues.occurrence_count + 1,
       error_detail_json = excluded.error_detail_json,
       last_seen_at = excluded.last_seen_at,
       status = 'pending',
       processed_at = NULL,
       processed_by_user_id = NULL`,
  ).bind(
    `siy_${ulid().toLowerCase()}`,
    input.accountId,
    input.category,
    input.sourceType,
    input.sourceId,
    input.operation,
    input.errorCode,
    input.errorDetailJson,
    input.nowIso,
  );
}

export async function listSystemIssues(input: {
  db: D1Database;
  accountId: string;
}): Promise<{ items: Array<Record<string, unknown>> }> {
  const result = await input.db.prepare(
    `SELECT id, category, source_type, source_id, operation, error_code,
            error_detail_json, status, occurrence_count, first_seen_at, last_seen_at,
            processed_at, processed_by_user_id
     FROM system_issues
     WHERE account_id = ?1
     ORDER BY last_seen_at DESC, id DESC
     LIMIT 200`,
  ).bind(input.accountId).all<Record<string, any>>();
  return {
    items: result.results.map((row) => ({
      id: row.id,
      category: row.category,
      sourceType: row.source_type,
      sourceId: row.source_id,
      operation: row.operation,
      errorCode: row.error_code,
      error: parseJsonObject(row.error_detail_json),
      status: row.status,
      occurrenceCount: row.occurrence_count,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      processedAt: row.processed_at,
      processedByUserId: row.processed_by_user_id,
    })),
  };
}
