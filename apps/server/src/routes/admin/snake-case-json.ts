function snakeCaseKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Converts internal camelCase result objects into the public JSON contract. */
export function toSnakeCaseJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCaseJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      snakeCaseKey(key),
      toSnakeCaseJson(item),
    ]),
  );
}
