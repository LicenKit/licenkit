import { ulid } from "ulid";
import { computeHmacSha256 } from "../crypto";
import { decryptEnvelopeV1, type DeliveryCryptoEnv } from "./crypto";
import { OutboundUrlPolicyError, requirePublicHttpsUrl } from "./url-policy";

interface DeliveryRow {
  id: string;
  account_id: string;
  target_url: string;
  signing_secret_ciphertext: string;
  payload_ciphertext: string;
  payload_expires_at: string;
  attempt_count: number;
  automatic_attempt_count: number;
  max_automatic_attempts: number;
  timeout_ms: number;
}

export interface DispatchDeliveryInput {
  db: D1Database;
  env: DeliveryCryptoEnv;
  accountId: string;
  deliveryId: string;
  workerId?: string;
  manual?: boolean;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface DispatchDeliveryResult {
  claimed: boolean;
  status?: "accepted" | "retry_scheduled" | "failed" | "payload_expired";
  attemptNumber?: number;
  httpStatus?: number | null;
  errorCode?: string | null;
}

interface HttpAttemptResult {
  outcome: "accepted" | "http_error" | "transport_error" | "timeout";
  httpStatus: number | null;
  responseBody: string | null;
  errorCode: string | null;
  errorDetail: string | null;
}

function changes(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

function backoffSeconds(attempt: number): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  const random = crypto.getRandomValues(new Uint16Array(1))[0] / 65535;
  return Math.round(base * (0.8 + random * 0.4));
}

const SENSITIVE_RESPONSE_KEYS = /(?:authorization|cookie|password|secret|token|license[_-]?key|api[_-]?key)/i;

function redactStructured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructured);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SENSITIVE_RESPONSE_KEYS.test(key) ? "[REDACTED]" : redactStructured(nested),
    ])
  );
}

function redactResponseBody(raw: string): string | null {
  if (!raw) return null;
  try {
    return JSON.stringify(redactStructured(JSON.parse(raw))).slice(0, 2048);
  } catch {
    return raw
      .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
      .replace(/\b(?:LIC|LK)-[A-Z0-9-]{10,}\b/gi, "[REDACTED_LICENSE_KEY]")
      .replace(/\b(authorization|cookie|password|secret|token|license[_-]?key|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
      .slice(0, 2048);
  }
}

async function postWithValidatedRedirects(input: {
  url: string;
  body: string;
  deliveryId: string;
  secret: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<HttpAttemptResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await computeHmacSha256(`${timestamp}.${input.body}`, input.secret);
  let target = requirePublicHttpsUrl(input.url);
  const startedAt = Date.now();

  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await input.fetchImpl(target.toString(), {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "X-LicenKit-Delivery": input.deliveryId,
          "X-LicenKit-Timestamp": String(timestamp),
          "X-LicenKit-Signature": `v1=${signature}`,
        },
        body: input.body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === 3) {
          return {
            outcome: "http_error",
            httpStatus: response.status,
            responseBody: null,
            errorCode: "OUTBOUND_REDIRECT_INVALID",
            errorDetail: location ? "Too many redirects" : "Redirect response did not include Location",
          };
        }
        target = requirePublicHttpsUrl(new URL(location, target).toString());
        continue;
      }
      const responseBody = redactResponseBody(await response.text());
      return response.ok
        ? { outcome: "accepted", httpStatus: response.status, responseBody, errorCode: null, errorDetail: null }
        : {
            outcome: "http_error",
            httpStatus: response.status,
            responseBody,
            errorCode: `OUTBOUND_HTTP_${response.status}`,
            errorDetail: `Notification endpoint returned HTTP ${response.status}`,
          };
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof OutboundUrlPolicyError) {
        return {
          outcome: "transport_error",
          httpStatus: null,
          responseBody: null,
          errorCode: error.code,
          errorDetail: error.message,
        };
      }
      const isTimeout = error instanceof DOMException && error.name === "AbortError";
      return {
        outcome: isTimeout ? "timeout" : "transport_error",
        httpStatus: null,
        responseBody: null,
        errorCode: isTimeout ? "OUTBOUND_TIMEOUT" : "OUTBOUND_TRANSPORT_ERROR",
        errorDetail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    outcome: "transport_error",
    httpStatus: null,
    responseBody: null,
    errorCode: "OUTBOUND_REDIRECT_INVALID",
    errorDetail: `Redirect loop ended after ${Date.now() - startedAt}ms`,
  };
}

export async function dispatchDelivery(input: DispatchDeliveryInput): Promise<DispatchDeliveryResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const workerId = input.workerId ?? `worker_${ulid().toLowerCase()}`;
  const lockedUntil = new Date(now.getTime() + 60_000).toISOString();
  const manual = input.manual === true;

  const expired = await input.db
    .prepare(
      `UPDATE outbound_deliveries
       SET status = 'payload_expired', payload_ciphertext = NULL,
           payload_cleared_at = ?1, locked_by = NULL, locked_until = NULL, updated_at = ?1
       WHERE account_id = ?2 AND id = ?3
         AND payload_ciphertext IS NOT NULL AND payload_expires_at <= ?1
         AND status NOT IN ('accepted', 'payload_expired')`
    )
    .bind(nowIso, input.accountId, input.deliveryId)
    .run();
  if (changes(expired) > 0) return { claimed: true, status: "payload_expired" };

  const claim = await input.db
    .prepare(
      `UPDATE outbound_deliveries
       SET status = 'processing', locked_by = ?1, locked_until = ?2, updated_at = ?3
       WHERE account_id = ?4 AND id = ?5
         AND payload_ciphertext IS NOT NULL AND payload_expires_at > ?3
         AND (
           (?6 = 1 AND status = 'failed')
           OR (?6 = 0 AND (
             (status IN ('pending', 'retry_scheduled') AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
             OR (status = 'processing' AND locked_until <= ?3)
           ))
         )`
    )
    .bind(workerId, lockedUntil, nowIso, input.accountId, input.deliveryId, manual ? 1 : 0)
    .run();
  if (changes(claim) !== 1) return { claimed: false };

  const rowResult = await input.db
    .prepare(
      `SELECT d.id, d.account_id, d.target_url, d.signing_secret_ciphertext,
              d.payload_ciphertext, d.payload_expires_at, d.attempt_count,
              d.automatic_attempt_count, d.max_automatic_attempts,
              COALESCE(e.timeout_ms, 10000) AS timeout_ms
       FROM outbound_deliveries AS d
       LEFT JOIN outbound_endpoints AS e
         ON e.account_id = d.account_id AND e.id = d.endpoint_id
       WHERE d.account_id = ?1 AND d.id = ?2 AND d.locked_by = ?3`
    )
    .bind(input.accountId, input.deliveryId, workerId)
    .all<DeliveryRow>();
  const row = rowResult.results[0];
  if (!row) return { claimed: false };

  const attemptNumber = row.attempt_count + 1;
  const attemptSource = manual ? "manual_retry" : attemptNumber === 1 ? "initial" : "automatic_retry";
  const startedAt = new Date();
  let attempt: HttpAttemptResult;
  try {
    const [body, secret] = await Promise.all([
      decryptEnvelopeV1(row.payload_ciphertext, input.env, {
        accountId: row.account_id,
        table: "outbound_deliveries",
        rowId: row.id,
        field: "payload_ciphertext",
      }),
      decryptEnvelopeV1(row.signing_secret_ciphertext, input.env, {
        accountId: row.account_id,
        table: "outbound_deliveries",
        rowId: row.id,
        field: "signing_secret_ciphertext",
      }),
    ]);
    attempt = await postWithValidatedRedirects({
      url: row.target_url,
      body,
      deliveryId: row.id,
      secret,
      fetchImpl: input.fetchImpl ?? fetch,
      timeoutMs: row.timeout_ms,
    });
  } catch (error) {
    attempt = {
      outcome: "transport_error",
      httpStatus: null,
      responseBody: null,
      errorCode: error instanceof OutboundUrlPolicyError ? error.code : "OUTBOUND_CONFIGURATION_ERROR",
      errorDetail: error instanceof Error ? error.message : String(error),
    };
  }

  const completedAt = new Date();
  const newAutomaticCount = manual ? row.automatic_attempt_count : row.automatic_attempt_count + 1;
  const permanentFailure =
    attempt.errorCode === "OUTBOUND_ENDPOINT_NOT_PUBLIC" ||
    attempt.errorCode === "OUTBOUND_CONFIGURATION_ERROR";
  const accepted = attempt.outcome === "accepted";
  const hasAutomaticBudget = newAutomaticCount < row.max_automatic_attempts;
  const status = accepted
    ? "accepted"
    : manual || permanentFailure || !hasAutomaticBudget
      ? "failed"
      : "retry_scheduled";
  const nextAttemptAt =
    status === "retry_scheduled"
      ? new Date(completedAt.getTime() + backoffSeconds(newAutomaticCount) * 1000).toISOString()
      : null;

  const attemptStatement = input.db
    .prepare(
      `INSERT INTO outbound_attempts (
         id, account_id, delivery_id, attempt_number, attempt_source, outcome,
         http_status, response_body_redacted, transport_error_code,
         transport_error_detail, started_at, completed_at, duration_ms
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    )
    .bind(
      `oat_${ulid().toLowerCase()}`,
      row.account_id,
      row.id,
      attemptNumber,
      attemptSource,
      attempt.outcome,
      attempt.httpStatus,
      attempt.responseBody,
      attempt.errorCode,
      attempt.errorDetail?.slice(0, 2048) ?? null,
      startedAt.toISOString(),
      completedAt.toISOString(),
      Math.max(0, completedAt.getTime() - startedAt.getTime())
    );
  const updateStatement = input.db
    .prepare(
      `UPDATE outbound_deliveries
       SET status = ?1, attempt_count = ?2, automatic_attempt_count = ?3,
           next_attempt_at = ?4, last_error_code = ?5, last_error_detail = ?6,
           accepted_at = CASE WHEN ?1 = 'accepted' THEN ?7 ELSE accepted_at END,
           payload_ciphertext = CASE WHEN ?1 = 'accepted' THEN NULL ELSE payload_ciphertext END,
           payload_cleared_at = CASE WHEN ?1 = 'accepted' THEN ?7 ELSE payload_cleared_at END,
           locked_by = NULL, locked_until = NULL, updated_at = ?7
       WHERE account_id = ?8 AND id = ?9 AND locked_by = ?10`
    )
    .bind(
      status,
      attemptNumber,
      newAutomaticCount,
      nextAttemptAt,
      accepted ? null : attempt.errorCode,
      accepted ? null : attempt.errorDetail?.slice(0, 2048) ?? null,
      completedAt.toISOString(),
      row.account_id,
      row.id,
      workerId
    );
  const completeCheckoutVerification = input.db
    .prepare(
      `UPDATE billing_checkout_verifications
       SET status = 'completed', completed_at = ?1, updated_at = ?1
       WHERE account_id = ?2 AND delivery_id = ?3
         AND status = 'delivery_pending' AND ?4 = 'accepted'`
    )
    .bind(completedAt.toISOString(), row.account_id, row.id, status);
  await input.db.batch([attemptStatement, updateStatement, completeCheckoutVerification]);

  return {
    claimed: true,
    status,
    attemptNumber,
    httpStatus: attempt.httpStatus,
    errorCode: attempt.errorCode,
  };
}
