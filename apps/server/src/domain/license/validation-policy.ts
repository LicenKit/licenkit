export const DEFAULT_VALIDATION_INTERVAL_SECONDS = 3600;
export const MIN_VALIDATION_INTERVAL_SECONDS = 3600;
export const MAX_VALIDATION_INTERVAL_SECONDS = 86400;

export function createServerValidationMetadata(validatedAt: Date) {
  return {
    validation_interval_seconds: null as number | null,
    validated_at: validatedAt.toISOString(),
  };
}
