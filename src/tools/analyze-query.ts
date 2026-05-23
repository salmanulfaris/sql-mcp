import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseDriver } from '../drivers/base.js';
import { classifySqlStatement, hasMultipleStatements } from '../permissions.js';

export function registerAnalyzeQuery(server: McpServer, driver: DatabaseDriver): void {
  server.registerTool(
    'analyze_query',
    {
      description:
        'Analyze a SQL query for performance: shows the execution plan and detects common issues like full table scans, missing indexes, filesort, and temporary tables. Use this when investigating slow queries or bad indexing. Defaults to plan-only (does not execute). Set execute=true to capture real timing on SELECT queries.',
      inputSchema: z.object({
        sql: z.string().min(1).describe('SQL query to analyze'),
        execute: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'If true, actually executes the query to capture real timing. SELECT only. Default: false (plan-only).',
          ),
        timeout_ms: z
          .number()
          .int()
          .min(500)
          .max(60_000)
          .optional()
          .default(5000)
          .describe('Hard timeout for the analyze operation. Applies to execute=true mode. Default: 5000ms.'),
      }),
    },
    async ({ sql, execute, timeout_ms }) => {
      try {
        if (hasMultipleStatements(sql)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Multi-statement queries are not allowed. Analyze one statement at a time.',
              },
            ],
            isError: true,
          };
        }

        if (execute) {
          const stmtType = classifySqlStatement(sql);
          if (stmtType !== 'SELECT') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `ANALYZE with execute=true is only allowed for SELECT statements (got ${stmtType}). EXPLAIN ANALYZE would actually run the query and mutate data for write operations. Use execute=false for plan-only analysis of write statements.`,
                },
              ],
              isError: true,
            };
          }
        }

        const result = await driver.analyzeQuery(sql, { execute, timeoutMs: timeout_ms });

        if (result.timedOut) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Analyze timed out after ${timeout_ms}ms. Add a WHERE/LIMIT clause to narrow the query, or increase timeout_ms.`,
              },
            ],
            isError: true,
          };
        }

        const header = result.executed
          ? `Plan [${driver.dialect}] (EXPLAIN ANALYZE — actual execution timing):`
          : `Plan [${driver.dialect}] (EXPLAIN — planner estimates only):`;

        const parts: string[] = [header, '', result.raw, ''];

        if (result.insights.length > 0) {
          parts.push('Insights:');
          for (const i of result.insights) parts.push(`  ${i}`);
        } else {
          parts.push('Insights:');
          parts.push('  No performance issues detected.');
        }

        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
      } catch (err) {
        const dbErr = err as { code?: string; message: string };
        const code = dbErr.code ? ` [${dbErr.code}]` : '';
        return {
          content: [{ type: 'text' as const, text: `Analyze error${code}: ${dbErr.message}` }],
          isError: true,
        };
      }
    },
  );
}
