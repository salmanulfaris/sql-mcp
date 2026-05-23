# sql-mcp

> Give AI agents accurate MySQL schema and data access. No more schema guessing.

AI agents working on a codebase only see the code — not the live database. When they need schema or data, they guess, leading to wrong column names, bad types, and missed foreign keys. `sql-mcp` connects any MCP-compatible AI agent directly to your MySQL database with **read-only by default** and explicit opt-in for write operations.

## Quick Start

```bash
# Zero install — runs directly with npx
npx sql-mcp --db mysql://user:password@localhost:3306/mydb
```

## Integration

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "npx",
      "args": ["sql-mcp", "--db", "mysql://user:password@host:3306/mydb"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add sql-mcp npx sql-mcp --db mysql://user:password@host:3306/mydb
```

### Environment Variables (recommended for production)

```bash
DB_URL=mysql://user:password@host:3306/mydb npx sql-mcp
```

## Configuration

| Flag | Env Var | Default | Description |
|---|---|---|---|
| `--db <uri>` | `DB_URL` | required | MySQL connection URI |
| `--ssl` | `SSL=true` | false | Enable SSL/TLS for connection |
| `--allow-write` | `ALLOW_WRITE=true` | false | Enable INSERT and UPDATE |
| `--allow-delete` | `ALLOW_DELETE=true` | false | Enable DELETE |
| `--allow-ddl` | `ALLOW_DDL=true` | false | Enable ALTER, CREATE, DROP, TRUNCATE |
| `--allow-drop-database` | `ALLOW_DROP_DATABASE=true` | false | Enable DROP DATABASE |

CLI flags take precedence over environment variables.

## Available Tools

| Tool | Description | Permission |
|---|---|---|
| `list_tables` | List all tables and views in the database | Read-only (default) |
| `describe_table` | Full schema for one table: columns, types, indexes, FK | Read-only (default) |
| `get_schema` | Full database schema dump | Read-only (default) |
| `get_sample_data` | Sample N rows from a table | Read-only (default) |
| `query` | Execute any SQL statement | Depends on statement type |

## Security Model

- **Default**: only `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` are allowed.
- **Write operations** (`INSERT`, `UPDATE`): require `--allow-write`.
- **Delete**: requires `--allow-delete`.
- **DDL** (`ALTER`, `CREATE`, `DROP`, `TRUNCATE`): requires `--allow-ddl`.
- **DROP DATABASE**: requires `--allow-drop-database` even when `--allow-ddl` is set.
- **Multi-statement queries** (e.g. `SELECT 1; DROP TABLE x`): always blocked.
- **Unknown SQL statements** (`GRANT`, `REVOKE`, `CALL`, `LOAD DATA`, etc.): always blocked.
- **Identifier injection**: table names are validated with `/^[a-zA-Z0-9_]+$/` before interpolation.

## Architecture

```
CLI args / env vars
       │
       ▼
  ServerConfig (permissions + connection)
       │
       ├── createConnectionPool (mysql2)
       │
       └── McpServer
             ├── list_tables
             ├── describe_table
             ├── get_schema
             ├── get_sample_data
             └── query ──► permissions.ts (classifier + gate)
                              │
                              └── pool.query / pool.execute
```

## Contributing

Contributions are welcome! Areas to contribute:

- **Add SQL statement types** — edit `src/permissions.ts`, add to `STATEMENT_MAP` and the `checkPermission` switch.
- **Add a new tool** — create `src/tools/your-tool.ts`, export a `registerYourTool(server, pool)` function, import and call it in `src/index.ts`.
- **Add database support** — PostgreSQL, SQLite, etc. will be added as separate connection adapters.

### Development

```bash
git clone https://github.com/your-org/sql-mcp
cd sql-mcp
npm install
npm run dev        # watch mode
npm run typecheck  # type check without emitting
npm run build      # compile to dist/
```

### Testing the server locally

```bash
node dist/index.js --db mysql://root:password@localhost:3306/testdb
```

Then use an MCP client (Claude Desktop, Claude Code) pointed at the local binary.

## License

MIT
