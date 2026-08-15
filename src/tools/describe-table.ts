import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseDriver } from '../drivers/base.js';
import type { OutputFormat } from '../types.js';
import { jsonResult, isJsonFormat } from '../format.js';

export function registerDescribeTable(
  server: McpServer,
  driver: DatabaseDriver,
  format: OutputFormat,
): void {
  server.registerTool(
    'describe_table',
    {
      description:
        'Get full schema details for a single table: columns with types, nullable, defaults, indexes, and foreign keys. Use this after list_tables to inspect only the tables relevant to the task — more efficient than get_schema for large databases.',
      inputSchema: z.object({
        table_name: z.string().min(1).describe('Name of the table to describe'),
      }),
    },
    async ({ table_name }) => {
      try {
        const desc = await driver.describeTable(table_name);

        if (isJsonFormat(format)) {
          return jsonResult({ dialect: driver.dialect, ...desc });
        }

        const parts: string[] = [`Table: ${desc.name} [${driver.dialect}]`, '', 'Columns:'];

        for (const col of desc.columns) {
          const nullable = col.nullable ? 'NULL    ' : 'NOT NULL';
          const key = col.isPrimaryKey ? 'PK' : col.isUnique ? 'UQ' : '  ';
          const extra = col.extra ? ` [${col.extra}]` : '';
          const def = col.defaultValue !== null ? ` DEFAULT ${col.defaultValue}` : '';
          parts.push(`  ${col.name.padEnd(24)} ${col.dataType.padEnd(20)} ${nullable}  ${key}${extra}${def}`);
        }

        parts.push('', 'Indexes:');
        if (desc.indexes.length === 0) {
          parts.push('  (none)');
        } else {
          for (const idx of desc.indexes) {
            const u = idx.unique ? 'UNIQUE  ' : '        ';
            parts.push(`  ${idx.name.padEnd(30)} ${u} (${idx.columns.join(', ')})`);
          }
        }

        parts.push('', 'Foreign Keys:');
        if (desc.foreignKeys.length === 0) {
          parts.push('  (none)');
        } else {
          for (const fk of desc.foreignKeys) {
            parts.push(
              `  ${fk.constraintName}: ${fk.column} → ${fk.referencedTable}.${fk.referencedColumn}`,
            );
          }
        }

        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isJsonFormat(format)) return jsonResult({ error: message }, true);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
