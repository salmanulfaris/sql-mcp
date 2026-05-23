import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isValidIdentifier } from '../permissions.js';

interface ColumnRow extends RowDataPacket {
  Field: string;
  Type: string;
  Null: string;
  Key: string;
  Default: string | null;
  Extra: string;
}

interface IndexRow extends RowDataPacket {
  Key_name: string;
  Non_unique: number;
  Column_name: string;
  Seq_in_index: number;
}

interface FkRow extends RowDataPacket {
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  CONSTRAINT_NAME: string;
}

export function registerDescribeTable(server: McpServer, pool: Pool): void {
  server.registerTool(
    'describe_table',
    {
      description:
        'Get full schema details for a table: columns with types, nullable, defaults, indexes, and foreign keys.',
      inputSchema: z.object({
        table_name: z.string().min(1).describe('Name of the table to describe'),
      }),
    },
    async ({ table_name }) => {
      try {
        if (!isValidIdentifier(table_name)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid table name '${table_name}'. Table names may only contain letters, numbers, and underscores.`,
              },
            ],
            isError: true,
          };
        }

        const [columns, indexes, fkRows] = await Promise.all([
          pool.query<ColumnRow[]>(`DESCRIBE \`${table_name}\``),
          pool.query<IndexRow[]>(`SHOW INDEX FROM \`${table_name}\``),
          pool.execute<FkRow[]>(
            `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = ?
               AND REFERENCED_TABLE_NAME IS NOT NULL
             ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
            [table_name],
          ),
        ]);

        const columnRows = columns[0];
        const indexRows = indexes[0];
        const foreignKeys = fkRows[0];

        const parts: string[] = [`Table: ${table_name}\n`, 'Columns:'];

        for (const col of columnRows) {
          const nullable = col.Null === 'YES' ? 'NULL' : 'NOT NULL';
          const defaultVal = col.Default !== null ? `DEFAULT ${col.Default}` : '';
          const extra = col.Extra ? col.Extra.toUpperCase() : '';
          const key = col.Key === 'PRI' ? 'PRIMARY KEY' : col.Key === 'UNI' ? 'UNIQUE' : '';
          const attrs = [nullable, extra, key, defaultVal].filter(Boolean).join('  ');
          parts.push(`  ${col.Field.padEnd(24)} ${col.Type.padEnd(20)} ${attrs}`);
        }

        // Group indexes
        const indexMap = new Map<string, { unique: boolean; columns: string[] }>();
        for (const idx of indexRows) {
          if (!indexMap.has(idx.Key_name)) {
            indexMap.set(idx.Key_name, { unique: idx.Non_unique === 0, columns: [] });
          }
          const entry = indexMap.get(idx.Key_name)!;
          entry.columns[idx.Seq_in_index - 1] = idx.Column_name;
        }

        parts.push('\nIndexes:');
        if (indexMap.size === 0) {
          parts.push('  (none)');
        } else {
          for (const [name, info] of indexMap) {
            const uniqueLabel = info.unique ? 'UNIQUE  ' : '        ';
            parts.push(`  ${name.padEnd(30)} ${uniqueLabel} (${info.columns.join(', ')})`);
          }
        }

        parts.push('\nForeign Keys:');
        if (foreignKeys.length === 0) {
          parts.push('  (none)');
        } else {
          for (const fk of foreignKeys) {
            parts.push(
              `  ${fk.CONSTRAINT_NAME}: ${fk.COLUMN_NAME} → ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`,
            );
          }
        }

        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
      } catch (err) {
        const mysqlErr = err as { code?: string; message: string };
        if (mysqlErr.code === 'ER_NO_SUCH_TABLE') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Table '${table_name}' does not exist in this database.`,
              },
            ],
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
