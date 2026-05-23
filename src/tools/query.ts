import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { classifySqlStatement, checkPermission, hasMultipleStatements } from '../permissions.js';
import type { PermissionConfig } from '../types.js';
import { formatTable } from '../format.js';

const READ_ONLY_TYPES = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN'];

function injectLimit(sql: string, maxRows: number): string {
  // Only inject LIMIT for SELECT statements that don't already have one
  if (!/\bLIMIT\b/i.test(sql)) {
    const trimmed = sql.trimEnd().replace(/;$/, '');
    return `${trimmed} LIMIT ${maxRows}`;
  }
  return sql;
}

export function registerQuery(
  server: McpServer,
  pool: Pool,
  permissions: PermissionConfig,
): void {
  server.registerTool(
    'query',
    {
      description:
        'Execute a SQL query. Read operations (SELECT, SHOW, DESCRIBE, EXPLAIN) are always allowed. Write and DDL operations require the server to be started with the appropriate flags.',
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
        // Block multi-statement queries
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

        const isReadOp = READ_ONLY_TYPES.includes(statementType);
        const finalSql =
          statementType === 'SELECT' ? injectLimit(sql, max_rows) : sql;

        const [result] = await pool.query(finalSql);

        if (isReadOp) {
          const rows = result as RowDataPacket[];
          if (rows.length === 0) {
            return { content: [{ type: 'text' as const, text: 'Query returned no rows.' }] };
          }
          const text = `${rows.length} row(s) returned:\n\n${formatTable(rows)}`;
          return { content: [{ type: 'text' as const, text }] };
        } else {
          const header = result as ResultSetHeader;
          const lines = [`Query executed successfully.`, `Affected rows: ${header.affectedRows}`];
          if (header.insertId > 0) lines.push(`Insert ID: ${header.insertId}`);
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
      } catch (err) {
        const mysqlErr = err as { code?: string; message: string };
        const code = mysqlErr.code ? ` [${mysqlErr.code}]` : '';
        return {
          content: [
            { type: 'text' as const, text: `MySQL error${code}: ${mysqlErr.message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
