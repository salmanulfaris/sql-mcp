#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createDriver } from './drivers/index.js';
import { registerListTables } from './tools/list-tables.js';
import { registerDescribeTable } from './tools/describe-table.js';
import { registerGetSchema } from './tools/get-schema.js';
import { registerGetSampleData } from './tools/get-sample-data.js';
import { registerQuery } from './tools/query.js';
import { registerAnalyzeQuery } from './tools/analyze-query.js';
import type { ServerConfig } from './types.js';

function loadProjectConfig(): Record<string, string> {
  try {
    const content = readFileSync(join(process.cwd(), '.sql-mcp'), 'utf8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    process.stderr.write(`sql-mcp: Loaded project config from .sql-mcp\n`);
    return result;
  } catch {
    return {};
  }
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  const env = process.env;
  const project = loadProjectConfig();

  // Priority: CLI flags > .sql-mcp > environment variables
  let dbUri = project['DB_URL'] ?? env['DB_URL'] ?? '';
  let ssl = (project['SSL'] ?? env['SSL']) === 'true';
  let allowWrite = (project['ALLOW_WRITE'] ?? env['ALLOW_WRITE']) === 'true';
  let allowDelete = (project['ALLOW_DELETE'] ?? env['ALLOW_DELETE']) === 'true';
  let allowDDL = (project['ALLOW_DDL'] ?? env['ALLOW_DDL']) === 'true';
  let allowDropDatabase = (project['ALLOW_DROP_DATABASE'] ?? env['ALLOW_DROP_DATABASE']) === 'true';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--db' && args[i + 1]) dbUri = args[++i];
    else if (arg === '--ssl') ssl = true;
    else if (arg === '--allow-write') allowWrite = true;
    else if (arg === '--allow-delete') allowDelete = true;
    else if (arg === '--allow-ddl') allowDDL = true;
    else if (arg === '--allow-drop-database') allowDropDatabase = true;
  }

  if (!dbUri) {
    process.stderr.write(
      [
        'sql-mcp: database connection URI is required.',
        '',
        'Usage:',
        '  sql-mcp --db <connection-uri> [options]',
        '',
        'Supported databases:',
        '  MySQL:      mysql://user:password@host:3306/database',
        '  PostgreSQL: postgres://user:password@host:5432/database',
        '  SQLite:     sqlite:./path/to/database.db',
        '',
        'Options:',
        '  --db <uri>              Connection URI (or set DB_URL env var)',
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

  let driver;
  try {
    driver = createDriver(config.connection.uri, config.connection.ssl);
  } catch (err) {
    process.stderr.write(`sql-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    await driver.testConnection();
    process.stderr.write(`sql-mcp: Connected to ${driver.dialect} successfully.\n`);
  } catch (err) {
    process.stderr.write(`sql-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const shutdown = async () => {
    await driver.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const server = new McpServer({
    name: 'sql-mcp',
    version: '0.3.2',
  });

  registerListTables(server, driver);
  registerDescribeTable(server, driver);
  registerGetSchema(server, driver);
  registerGetSampleData(server, driver);
  registerQuery(server, driver, config.permissions);
  registerAnalyzeQuery(server, driver);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`sql-mcp: Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
