import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseDriver } from '../drivers/base.js';

const MAX_RESPONSE_CHARS = 100_000;

export function registerGetSchema(server: McpServer, driver: DatabaseDriver): void {
  server.registerTool(
    'get_schema',
    {
      description:
        'Get the full schema of the connected database: all tables, columns, types, keys, and foreign key relationships. WARNING: avoid this on databases with many tables — it will flood the context window and degrade reasoning. Prefer this workflow instead: call list_tables first to see what exists, then describe_table for only the tables relevant to the task.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const tables = await driver.getSchema();
        const parts: string[] = [
          `Database Schema [${driver.dialect}] — ${tables.length} table(s)`,
          `Generated: ${new Date().toISOString()}`,
          '',
        ];

        for (const table of tables) {
          parts.push('═'.repeat(50));
          parts.push(`Table: ${table.name}`);
          parts.push('═'.repeat(50));

          const fkMap = new Map<string, string>();
          for (const fk of table.foreignKeys) {
            fkMap.set(fk.column, `${fk.referencedTable}.${fk.referencedColumn}`);
          }

          for (const col of table.columns) {
            const nullable = col.nullable ? 'NULL    ' : 'NOT NULL';
            const key = col.isPrimaryKey ? ' PK' : col.isUnique ? ' UQ' : '   ';
            const extra = col.extra ? ` [${col.extra}]` : '';
            const fkRef = fkMap.get(col.name);
            const fkLabel = fkRef ? ` → ${fkRef}` : '';
            const def = col.defaultValue !== null ? ` DEFAULT ${col.defaultValue}` : '';
            parts.push(
              `  ${col.name.padEnd(28)} ${col.dataType.padEnd(24)} ${nullable}${key}${extra}${fkLabel}${def}`,
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
