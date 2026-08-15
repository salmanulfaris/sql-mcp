import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseDriver } from '../drivers/base.js';
import type { OutputFormat } from '../types.js';
import { jsonResult, isJsonFormat } from '../format.js';

const MAX_RESPONSE_CHARS = 100_000;

export function registerGetSchema(
  server: McpServer,
  driver: DatabaseDriver,
  format: OutputFormat,
): void {
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

        if (isJsonFormat(format)) {
          const payload = JSON.stringify({
            dialect: driver.dialect,
            generated: new Date().toISOString(),
            tables,
          });
          // Don't truncate JSON — a chopped string is unparseable. Point the
          // agent at describe_table instead, still as valid JSON.
          if (payload.length > MAX_RESPONSE_CHARS) {
            return jsonResult({
              error: 'schema_too_large',
              dialect: driver.dialect,
              tableCount: tables.length,
              hint: 'Use describe_table on specific tables instead of get_schema.',
            });
          }
          return { content: [{ type: 'text' as const, text: payload }] };
        }

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
        if (isJsonFormat(format)) return jsonResult({ error: message }, true);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
