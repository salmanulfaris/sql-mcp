import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const MAX_RESPONSE_CHARS = 100_000;

interface ColumnInfoRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number;
  COLUMN_DEFAULT: string | null;
  IS_NULLABLE: string;
  COLUMN_TYPE: string;
  COLUMN_KEY: string;
  EXTRA: string;
  COLUMN_COMMENT: string;
}

interface FkInfoRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
}

export function registerGetSchema(server: McpServer, pool: Pool): void {
  server.registerTool(
    'get_schema',
    {
      description:
        'Get the full schema of the MySQL database: all tables, columns, types, keys, and foreign key relationships.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const [columnRows, fkRows] = await Promise.all([
          pool.query<ColumnInfoRow[]>(
            `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT,
                    IS_NULLABLE, COLUMN_TYPE, COLUMN_KEY, EXTRA, COLUMN_COMMENT
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
             ORDER BY TABLE_NAME, ORDINAL_POSITION`,
          ),
          pool.query<FkInfoRow[]>(
            `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE()
               AND REFERENCED_TABLE_NAME IS NOT NULL`,
          ),
        ]);

        const columns = columnRows[0];
        const fks = fkRows[0];

        // Build FK lookup: table.column → ref_table.ref_column
        const fkMap = new Map<string, string>();
        for (const fk of fks) {
          fkMap.set(
            `${fk.TABLE_NAME}.${fk.COLUMN_NAME}`,
            `${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`,
          );
        }

        // Group columns by table
        const tableMap = new Map<string, ColumnInfoRow[]>();
        for (const col of columns) {
          if (!tableMap.has(col.TABLE_NAME)) tableMap.set(col.TABLE_NAME, []);
          tableMap.get(col.TABLE_NAME)!.push(col);
        }

        const tableCount = tableMap.size;
        const parts: string[] = [
          `Database Schema — ${tableCount} table(s)`,
          `Generated: ${new Date().toISOString()}`,
          '',
        ];

        for (const [tableName, cols] of tableMap) {
          parts.push('═'.repeat(50));
          parts.push(`Table: ${tableName}`);
          parts.push('═'.repeat(50));

          for (const col of cols) {
            const nullable = col.IS_NULLABLE === 'YES' ? 'NULL    ' : 'NOT NULL';
            const key =
              col.COLUMN_KEY === 'PRI'
                ? ' PK'
                : col.COLUMN_KEY === 'UNI'
                  ? ' UQ'
                  : col.COLUMN_KEY === 'MUL'
                    ? ' IX'
                    : '   ';
            const extra = col.EXTRA ? ` [${col.EXTRA}]` : '';
            const fkRef = fkMap.get(`${tableName}.${col.COLUMN_NAME}`);
            const fkLabel = fkRef ? ` → ${fkRef}` : '';
            const defaultVal =
              col.COLUMN_DEFAULT !== null ? ` DEFAULT ${col.COLUMN_DEFAULT}` : '';
            parts.push(
              `  ${col.COLUMN_NAME.padEnd(28)} ${col.COLUMN_TYPE.padEnd(24)} ${nullable}${key}${extra}${fkLabel}${defaultVal}`,
            );
          }
          parts.push('');
        }

        const text = parts.join('\n');

        if (text.length > MAX_RESPONSE_CHARS) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  text.slice(0, MAX_RESPONSE_CHARS) +
                  '\n\n[Schema truncated — too large to display in full. Use describe_table to inspect specific tables.]',
              },
            ],
          };
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
