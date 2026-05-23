import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerListTables(server: McpServer, pool: Pool): void {
  server.registerTool(
    'list_tables',
    {
      description:
        'List all tables and views in the connected MySQL database with their types.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const [rows] = await pool.query<RowDataPacket[]>('SHOW FULL TABLES');

        const tables: string[] = [];
        const views: string[] = [];

        for (const row of rows) {
          const values = Object.values(row) as string[];
          const name = values[0];
          const type = values[1];
          if (type === 'VIEW') {
            views.push(name);
          } else {
            tables.push(name);
          }
        }

        const totalCount = tables.length + views.length;
        const parts: string[] = [];

        parts.push(
          `${totalCount} object(s) found (${tables.length} table(s), ${views.length} view(s)):\n`,
        );

        if (tables.length > 0) {
          parts.push('Tables:');
          for (const t of tables) parts.push(`  - ${t}`);
        }

        if (views.length > 0) {
          if (tables.length > 0) parts.push('');
          parts.push('Views:');
          for (const v of views) parts.push(`  - ${v}`);
        }

        if (totalCount === 0) {
          parts.push('No tables or views found in this database.');
        }

        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
