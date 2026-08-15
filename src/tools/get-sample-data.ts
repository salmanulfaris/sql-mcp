import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseDriver } from '../drivers/base.js';
import type { OutputFormat } from '../types.js';
import { formatTable, jsonResult, isJsonFormat, toValueArrays } from '../format.js';

export function registerGetSampleData(
  server: McpServer,
  driver: DatabaseDriver,
  format: OutputFormat,
): void {
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
        if (order_by && !/^[a-zA-Z0-9_,.()\s]+$/.test(order_by)) {
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

        const result = await driver.getSampleData(table_name, limit, order_by);
        const rows = result.rows ?? [];

        if (isJsonFormat(format)) {
          const cols = result.columns ?? [];
          return jsonResult({
            table: table_name,
            dialect: driver.dialect,
            rowCount: rows.length,
            columns: cols,
            rows: format === 'json-compact' ? toValueArrays(rows, cols) : rows,
          });
        }

        if (rows.length === 0) {
          return { content: [{ type: 'text' as const, text: `Table '${table_name}' is empty.` }] };
        }

        const text = `Sample data from '${table_name}' [${driver.dialect}] (${rows.length} row(s)):\n\n${formatTable(rows, result.columns)}`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isJsonFormat(format)) return jsonResult({ error: message }, true);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
