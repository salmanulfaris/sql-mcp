export function formatTable(
  rows: Record<string, unknown>[],
  columns?: string[],
): string {
  if (rows.length === 0) return '(no rows)';

  const cols = columns && columns.length > 0 ? columns : Object.keys(rows[0]);
  const colWidths = cols.map((col) => {
    const maxDataWidth = rows.reduce((max, row) => {
      const val = row[col];
      const str = val === null || val === undefined ? 'NULL' : String(val);
      return Math.max(max, str.length);
    }, 0);
    return Math.max(col.length, maxDataWidth);
  });

  const header = cols.map((col, i) => col.padEnd(colWidths[i])).join(' | ');
  const separator = colWidths.map((w) => '-'.repeat(w)).join('-+-');
  const dataRows = rows.map((row) =>
    cols
      .map((col, i) => {
        const val = row[col];
        const str = val === null || val === undefined ? 'NULL' : String(val);
        return str.padEnd(colWidths[i]);
      })
      .join(' | '),
  );

  return [header, separator, ...dataRows].join('\n');
}
