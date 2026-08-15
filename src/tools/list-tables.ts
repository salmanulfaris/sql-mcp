import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseDriver } from '../drivers/base.js';
import type { OutputFormat } from '../types.js';
import { jsonResult, isJsonFormat } from '../format.js';

export function registerListTables(
  server: McpServer,
  driver: DatabaseDriver,
  format: OutputFormat,
): void {
  server.registerTool(
    'list_tables',
    {
      description:
        'List all tables and views in the connected database with their types. Start here — call this first to understand what tables exist, then use describe_table on only the tables relevant to your task. Prefer this over get_schema for any database with many tables.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const items = await driver.listTables();
        const tables = items.filter((i) => i.type === 'TABLE').map((i) => i.name);
        const views = items.filter((i) => i.type === 'VIEW').map((i) => i.name);

        if (isJsonFormat(format)) {
          return jsonResult({ dialect: driver.dialect, tables, views });
        }

        const parts: string[] = [
          `${items.length} object(s) found (${tables.length} table(s), ${views.length} view(s)) [${driver.dialect}]:`,
          '',
        ];
        if (tables.length > 0) {
          parts.push('Tables:');
          for (const t of tables) parts.push(`  - ${t}`);
        }
        if (views.length > 0) {
          if (tables.length > 0) parts.push('');
          parts.push('Views:');
          for (const v of views) parts.push(`  - ${v}`);
        }
        if (items.length === 0) parts.push('No tables or views found.');

        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isJsonFormat(format)) return jsonResult({ error: message }, true);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
