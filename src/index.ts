#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createConnectionPool, testConnection } from './connection.js';
import { registerListTables } from './tools/list-tables.js';
import { registerDescribeTable } from './tools/describe-table.js';
import { registerGetSchema } from './tools/get-schema.js';
import { registerGetSampleData } from './tools/get-sample-data.js';
import { registerQuery } from './tools/query.js';
import type { ServerConfig } from './types.js';

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  const env = process.env;

  let dbUri = env['DB_URL'] ?? '';
  let ssl = env['SSL'] === 'true';
  let allowWrite = env['ALLOW_WRITE'] === 'true';
  let allowDelete = env['ALLOW_DELETE'] === 'true';
  let allowDDL = env['ALLOW_DDL'] === 'true';
  let allowDropDatabase = env['ALLOW_DROP_DATABASE'] === 'true';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--db' && args[i + 1]) {
      dbUri = args[++i];
    } else if (arg === '--ssl') {
      ssl = true;
    } else if (arg === '--allow-write') {
      allowWrite = true;
    } else if (arg === '--allow-delete') {
      allowDelete = true;
    } else if (arg === '--allow-ddl') {
      allowDDL = true;
    } else if (arg === '--allow-drop-database') {
      allowDropDatabase = true;
    }
  }

  if (!dbUri) {
    process.stderr.write(
      [
        'sql-mcp: MySQL connection URI is required.',
        '',
        'Usage:',
        '  sql-mcp --db mysql://user:password@host:3306/database [options]',
        '',
        'Options:',
        '  --db <uri>              MySQL connection URI (or set DB_URL env var)',
        '  --ssl                   Enable SSL/TLS (or set SSL=true)',
        '  --allow-write           Enable INSERT and UPDATE (or ALLOW_WRITE=true)',
        '  --allow-delete          Enable DELETE (or ALLOW_DELETE=true)',
        '  --allow-ddl             Enable ALTER, CREATE, DROP, TRUNCATE (or ALLOW_DDL=true)',
        '  --allow-drop-database   Enable DROP DATABASE (or ALLOW_DROP_DATABASE=true)',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  return {
    connection: { uri: dbUri, ssl },
    permissions: { allowWrite, allowDelete, allowDDL, allowDropDatabase },
  };
}

async function main(): Promise<void> {
  const config = parseArgs();
  const pool = createConnectionPool(config.connection);

  try {
    await testConnection(pool);
    process.stderr.write('sql-mcp: Connected to MySQL successfully.\n');
  } catch (err) {
    process.stderr.write(`sql-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    await pool.end();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await pool.end();
    process.exit(0);
  });

  const server = new McpServer({
    name: 'sql-mcp',
    version: '0.1.0',
  });

  registerListTables(server, pool);
  registerDescribeTable(server, pool);
  registerGetSchema(server, pool);
  registerGetSampleData(server, pool);
  registerQuery(server, pool, config.permissions);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`sql-mcp: Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
