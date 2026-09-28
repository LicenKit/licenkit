export const DEFAULT_VALIDATION_INTERVAL_SECONDS = 3600;
export const MIN_VALIDATION_INTERVAL_SECONDS = 3600;
export const MAX_VALIDATION_INTERVAL_SECONDS = 86400;

export function createServerValidationMetadata(input: {
  validatedAt: Date;
  validationIntervalSeconds: number;
  offlineGraceSeconds: number | null;
}) {
  if (
    !Number.isInteger(input.validationIntervalSeconds)
    || input.validationIntervalSeconds < MIN_VALIDATION_INTERVAL_SECONDS
    || input.validationIntervalSeconds > MAX_VALIDATION_INTERVAL_SECONDS
  ) {
    throw new TypeError("Product validation interval must be an integer between 3600 and 86400 seconds.");
  }
  if (
    input.offlineGraceSeconds !== null
    && (!Number.isInteger(input.offlineGraceSeconds) || input.offlineGraceSeconds <= 0)
  ) {
    throw new TypeError("Offline grace must be a positive integer when present.");
  }
  return {
    validation_interval_seconds: input.validationIntervalSeconds,
    offline_grace_seconds: input.offlineGraceSeconds,
    validated_at: input.validatedAt.toISOString(),
  };
}
