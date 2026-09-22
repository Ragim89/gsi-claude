/**
 * Builds "col = $n" assignments for a PATCH from a DTO, using an explicit whitelist
 * mapping DTO field → column. Undefined fields are skipped; null clears the column.
 */
export function buildSet(
  dto: Record<string, unknown>,
  columns: Record<string, string>,
  startIndex = 1,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [field, column] of Object.entries(columns)) {
    if (dto[field] === undefined) continue;
    params.push(dto[field]);
    parts.push(`${column} = $${startIndex + params.length - 1}`);
  }
  return { sql: parts.join(', '), params };
}
