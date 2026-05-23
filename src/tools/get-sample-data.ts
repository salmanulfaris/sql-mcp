import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isValidIdentifier } from '../permissions.js';
import { formatTable } from '../format.js';

export function registerGetSampleData(server: McpServer, pool: Pool): void {
  server.registerTool(
    'get_sample_data',
    {
      description:
        'Get a sample of rows from a table. Always read-only. Useful for understanding data shape and values.',
      inputSchema: z.object({
        table_name: z.string().min(1).describe('Table to sample from'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(5)
          .describe('Number of rows to return (default: 5, max: 100)'),
        order_by: z
          .string()
          .optional()
          .describe('Optional ORDER BY expression, e.g. "created_at DESC"'),
      }),
    },
    async ({ table_name, limit, order_by }) => {
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

        // Sanitize order_by: allow only safe characters
        let orderClause = '';
        if (order_by) {
          if (!/^[a-zA-Z0-9_,.()\s]+$/.test(order_by)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Invalid order_by expression. Use only column names, commas, and ASC/DESC.',
                },
              ],
              isError: true,
            };
          }
          orderClause = `ORDER BY ${order_by}`;
        }

        const sql = `SELECT * FROM \`${table_name}\` ${orderClause} LIMIT ?`;
        const [rows] = await pool.execute<RowDataPacket[]>(sql, [limit]);

        if (rows.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `Table '${table_name}' is empty.` }],
          };
        }

        const text = `Sample data from '${table_name}' (${rows.length} row(s)):\n\n${formatTable(rows)}`;
        return { content: [{ type: 'text' as const, text }] };
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
