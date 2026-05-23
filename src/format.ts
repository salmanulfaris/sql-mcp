import type { RowDataPacket } from 'mysql2/promise';

export function formatTable(rows: RowDataPacket[]): string {
  if (rows.length === 0) return '(no rows)';

  const columns = Object.keys(rows[0]);
  const colWidths = columns.map((col) => {
    const maxDataWidth = rows.reduce((max, row) => {
      const val = row[col];
      const str = val === null ? 'NULL' : String(val);
      return Math.max(max, str.length);
    }, 0);
    return Math.max(col.length, maxDataWidth);
  });

  const header = columns.map((col, i) => col.padEnd(colWidths[i])).join(' | ');
  const separator = colWidths.map((w) => '-'.repeat(w)).join('-+-');
  const dataRows = rows.map((row) =>
    columns
      .map((col, i) => {
        const val = row[col];
        const str = val === null ? 'NULL' : String(val);
        return str.padEnd(colWidths[i]);
      })
      .join(' | '),
  );

  return [header, separator, ...dataRows].join('\n');
}
