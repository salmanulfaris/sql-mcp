import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseDriver } from '../drivers/base.js';
import type { PermissionConfig } from '../types.js';
import { classifySqlStatement, checkPermission, hasMultipleStatements } from '../permissions.js';
import { formatTable } from '../format.js';

const READ_ONLY_TYPES = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN'];

export function registerQuery(
  server: McpServer,
  driver: DatabaseDriver,
  permissions: PermissionConfig,
): void {
  server.registerTool(
    'query',
    {
      description:
        'Execute a SQL query against the connected database. Read operations (SELECT, SHOW, DESCRIBE, EXPLAIN) are always allowed. Write and DDL operations require the server to be started with the appropriate flags.',
      inputSchema: z.object({
        sql: z.string().min(1).describe('SQL query to execute'),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .default(100)
          .describe('Maximum rows to return for SELECT queries (default: 100, max: 10000)'),
      }),
    },
    async ({ sql, max_rows }) => {
      try {
        if (hasMultipleStatements(sql)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Multi-statement queries are not allowed. Execute one statement at a time.',
              },
            ],
            isError: true,
          };
        }

        const statementType = classifySqlStatement(sql);
        const permission = checkPermission(statementType, permissions);

        if (!permission.allowed) {
          return {
            content: [{ type: 'text' as const, text: `Permission denied: ${permission.reason}` }],
            isError: true,
          };
        }

        const isReadOnly = READ_ONLY_TYPES.includes(statementType);
        // Only bound plain SELECTs. SHOW/DESCRIBE/EXPLAIN do not accept a LIMIT and
        // their output is inherently small. An EXPLAIN'd SELECT classifies as SELECT
        // here, and appending LIMIT to the EXPLAIN form is harmless.
        const appendLimit = statementType === 'SELECT';
        const result = await driver.executeQuery(sql, {
          isReadOnly,
          appendLimit,
          maxRows: max_rows,
        });

        if (isReadOnly) {
          const rows = result.rows ?? [];
          if (rows.length === 0) {
            return { content: [{ type: 'text' as const, text: 'Query returned no rows.' }] };
          }
          const text = `${rows.length} row(s) returned [${driver.dialect}]:\n\n${formatTable(rows, result.columns)}`;
          return { content: [{ type: 'text' as const, text }] };
        } else {
          const lines = [
            `Query executed successfully [${driver.dialect}].`,
            `Affected rows: ${result.affectedRows ?? 0}`,
          ];
          if (result.insertId !== undefined) lines.push(`Insert ID: ${result.insertId}`);
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
      } catch (err) {
        const dbErr = err as { code?: string; message: string };
        const code = dbErr.code ? ` [${dbErr.code}]` : '';
        return {
          content: [{ type: 'text' as const, text: `Query error${code}: ${dbErr.message}` }],
          isError: true,
        };
      }
    },
  );
}
