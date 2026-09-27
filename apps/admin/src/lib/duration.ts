export const SECONDS_PER_DAY = 86_400;

export function daysToSeconds(days: string): number {
  const parsed = Number(days);
  const seconds = parsed * SECONDS_PER_DAY;
  if (!Number.isInteger(parsed) || parsed < 0 || !Number.isSafeInteger(seconds)) {
    throw new Error("Duration must be a non-negative whole number of days.");
  }
  return seconds;
}

export function secondsToDays(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds % SECONDS_PER_DAY !== 0) {
    throw new Error("Stored duration must be a non-negative whole number of days.");
  }
  return String(seconds / SECONDS_PER_DAY);
}
