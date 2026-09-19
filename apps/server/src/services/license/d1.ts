export async function firstD1<T>(statement: D1PreparedStatement): Promise<T | undefined> {
  const result = await statement.all<T>();
  return result.results[0] as T | undefined;
}
