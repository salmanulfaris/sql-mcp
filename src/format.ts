import type { OutputFormat } from './types.js';

/** True for any JSON output mode (object rows or value-array rows). */
export function isJsonFormat(f: OutputFormat): boolean {
  return f === 'json' || f === 'json-compact';
}

/**
 * Turn array-of-objects rows into positional value arrays in column order.
 * Used by 'json-compact' to avoid repeating column names on every row —
 * meaningfully fewer tokens on wide result sets.
 */
export function toValueArrays(
  rows: Record<string, unknown>[],
  columns: string[],
): unknown[][] {
  return rows.map((row) => columns.map((col) => row[col]));
}

/**
 * Wrap a value as a compact-JSON tool result. Compact (no indentation) is
 * deliberate — the point of JSON mode is fewer tokens than the text tables.
 */
export function jsonResult(
  obj: unknown,
  isError = false,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const result: { content: { type: 'text'; text: string }[]; isError?: boolean } = {
    content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
  };
  if (isError) result.isError = true;
  return result;
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  // Backstop for drivers that still hand back JS Date objects (e.g. mssql).
  // toISOString() gives an unambiguous UTC instant rather than the locale
  // timezone string that String(Date) produces.
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

export function formatTable(
  rows: Record<string, unknown>[],
  columns?: string[],
): string {
  if (rows.length === 0) return '(no rows)';

  const cols = columns && columns.length > 0 ? columns : Object.keys(rows[0]);
  const colWidths = cols.map((col) => {
    const maxDataWidth = rows.reduce((max, row) => {
      const str = formatValue(row[col]);
      return Math.max(max, str.length);
    }, 0);
    return Math.max(col.length, maxDataWidth);
  });

  const header = cols.map((col, i) => col.padEnd(colWidths[i])).join(' | ');
  const separator = colWidths.map((w) => '-'.repeat(w)).join('-+-');
  const dataRows = rows.map((row) =>
    cols
      .map((col, i) => formatValue(row[col]).padEnd(colWidths[i]))
      .join(' | '),
  );

  return [header, separator, ...dataRows].join('\n');
}
