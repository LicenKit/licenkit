const SENSITIVE_KEY = /(^|_)(api_?key|secret|token|authorization|password|card|license_?key|machine_?token)($|_)/i;
const EMAIL_KEY = /(^|_)(email)($|_)/i;

function redactEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return "[REDACTED_EMAIL]";
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

export function redactBillingDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactBillingDiagnostic(item, depth + 1));
  if (typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = "[REDACTED]";
    } else if (EMAIL_KEY.test(key) && typeof child === "string") {
      output[key] = redactEmail(child);
    } else {
      output[key] = redactBillingDiagnostic(child, depth + 1);
    }
  }
  return output;
}

export function serializeBillingDiagnostic(value: unknown, maxLength = 8_000): string {
  const text = JSON.stringify(redactBillingDiagnostic(value));
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...[TRUNCATED]`;
}

