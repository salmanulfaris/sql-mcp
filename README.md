# sql-mcp

> Give AI agents accurate SQL database schema and data access. No more schema guessing.

MCP clients like Claude Desktop, Cursor, and Windsurf don't have terminal access — so without an MCP server, they're limited to what's in your code files. `sql-mcp` gives them live schema and data access directly from your **MySQL, PostgreSQL, SQL Server, or SQLite** database, with **read-only by default** and explicit opt-in for write operations.

## Supported Databases

| Database | Connection URI |
|---|---|
| **MySQL** | `mysql://user:pass@host:3306/db` |
| **PostgreSQL** | `postgres://user:pass@host:5432/db` (or `postgresql://`) |
| **SQL Server** | `mssql://user:pass@host:1433/db` (or `sqlserver://`) |
| **SQLite** | `sqlite:./path/to/file.db` (or `file:./path` or just `*.db`/`*.sqlite`) |

The driver is auto-detected from the URI scheme.

## Quick Start

```bash
# MySQL
npx @salmanulfaris/sql-mcp --db 'mysql://user:password@localhost:3306/mydb'

# PostgreSQL
npx @salmanulfaris/sql-mcp --db 'postgres://user:password@localhost:5432/mydb'

# SQL Server
npx @salmanulfaris/sql-mcp --db 'mssql://user:password@localhost:1433/mydb'

# SQLite
npx @salmanulfaris/sql-mcp --db 'sqlite:./mydb.sqlite'
```

> **SQL Server TLS:** pass `--ssl` to enforce an encrypted, certificate-validated connection (required by Azure SQL). Without it, the connection is unencrypted and the server certificate is trusted (fine for local dev). You can also override per-connection with URI query params: `mssql://user:pass@host:1433/db?encrypt=true&trustServerCertificate=true`.

## Integration

### Claude Desktop (`claude_desktop_config.json`)

Location: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "npx",
      "args": ["@salmanulfaris/sql-mcp", "--db", "mysql://user:password@host:3306/mydb"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add sql-mcp -- npx @salmanulfaris/sql-mcp --db mysql://user:password@host:3306/mydb
```

Or with env var (recommended — keeps credentials out of process listings):

```bash
claude mcp add sql-mcp -e DB_URL=mysql://user:password@host:3306/mydb -- npx @salmanulfaris/sql-mcp
```

Note the `--` before `npx` — it tells `claude mcp add` to stop parsing flags so `--db` reaches our server.

#### Credential-free install

Register the server once with **no credentials in the command**:

```bash
claude mcp add sql-mcp -- npx @salmanulfaris/sql-mcp
```

This keeps your database URL out of shell history and MCP config files. sql-mcp resolves the database at startup instead, from whichever project you launch Claude in — a [`.sql-mcp` file](#per-project-database-config) in the project root, or a `DB_URL` environment variable. One global registration then serves every project, each connecting to its own database.

> With no `--db` flag, no `.sql-mcp` file, and no `DB_URL` set, the server has nothing to connect to and will report a startup error until you provide one of them.

See [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) for more on project-level vs global MCP setup.

### Cursor (`~/.cursor/mcp.json`)

Create or edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "npx",
      "args": ["@salmanulfaris/sql-mcp", "--db", "mysql://user:password@host:3306/mydb"]
    }
  }
}
```

After saving, open Cursor Settings → MCP and toggle the server on.

See [Cursor MCP docs](https://cursor.com/docs/mcp) for more on global vs project-level config.

### Antigravity (Google)

In Antigravity, open the MCP settings panel and add a new server, or edit your MCP config file:

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "npx",
      "args": ["@salmanulfaris/sql-mcp", "--db", "mysql://user:password@host:3306/mydb"],
      "env": {
        "DB_URL": "mysql://user:password@host:3306/mydb"
      }
    }
  }
}
```

### Codex (OpenAI) (`~/.codex/config.toml`)

Codex uses TOML format. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.sql-mcp]
command = "npx"
args = ["@salmanulfaris/sql-mcp", "--db", "mysql://user:password@host:3306/mydb"]
```

To enable write operations, add flags to the `args` array:

```toml
[mcp_servers.sql-mcp]
command = "npx"
args = [
  "@salmanulfaris/sql-mcp",
  "--db", "mysql://user:password@host:3306/mydb",
  "--allow-write"
]
```

### Windsurf (`~/.codeium/windsurf/mcp_config.json`)

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "npx",
      "args": ["@salmanulfaris/sql-mcp", "--db", "mysql://user:password@host:3306/mydb"]
    }
  }
}
```

## Per-Project Database Config

If you work across multiple projects with different databases, configure the connection per project instead of globally.

Create a `.sql-mcp` file in your project root:

```ini
DB_URL=mysql://user:password@localhost:3306/my_project_db
```

sql-mcp reads this file on startup. It takes precedence over the `DB_URL` environment variable, so switching projects automatically connects to the right database — as long as you don't also pass a `--db` flag on the command line, which overrides everything.

**Priority order:**

```
--db CLI flag  >  .sql-mcp file  >  DB_URL env var
```

You can also set permission flags in the file:

```ini
DB_URL=mysql://user:password@localhost:3306/my_project_db
ALLOW_WRITE=true
ALLOW_DELETE=true
```

> **Important:** Add `.sql-mcp` to your `.gitignore` — it contains credentials and should never be committed.

```bash
echo ".sql-mcp" >> .gitignore
```

The global MCP config (in Claude Desktop, Cursor, etc.) stays as-is. The `.sql-mcp` file just overrides the database for that specific project without touching any client config.

## Configuration

| Flag | Env Var | `.sql-mcp` key | Default | Description |
|---|---|---|---|---|
| `--db <uri>` | `DB_URL` | `DB_URL` | required | Connection URI |
| `--ssl` | `SSL=true` | `SSL=true` | false | Enable SSL/TLS |
| `--allow-write` | `ALLOW_WRITE=true` | `ALLOW_WRITE=true` | false | Enable INSERT and UPDATE |
| `--allow-delete` | `ALLOW_DELETE=true` | `ALLOW_DELETE=true` | false | Enable DELETE |
| `--allow-ddl` | `ALLOW_DDL=true` | `ALLOW_DDL=true` | false | Enable ALTER, CREATE, DROP, TRUNCATE |
| `--allow-drop-database` | `ALLOW_DROP_DATABASE=true` | `ALLOW_DROP_DATABASE=true` | false | Enable DROP DATABASE |
| `--output-format <fmt>` | `OUTPUT_FORMAT` | `OUTPUT_FORMAT` | `text` | Output format: `text`, `json`, or `json-compact` |

Priority: CLI flags > `.sql-mcp` file > environment variables.

### Output Format

By default, results are returned as human-readable text tables. Set `--output-format json` (or `OUTPUT_FORMAT=json`) to have every tool return compact JSON instead, which agents can parse directly.

| Format | Shape | When to use |
|---|---|---|
| `text` (default) | ASCII tables | Human-readable; good default |
| `json` | Rows as array-of-objects: `{"columns":[...],"rows":[{...},{...}]}` | Structured/nested data (schema, foreign keys); easiest to parse |
| `json-compact` | Rows as value arrays: `{"columns":[...],"rows":[[...],[...]]}` | Wide result sets — column names appear once, so it uses noticeably fewer tokens |

> **Note:** JSON is not always cheaper than text. For wide tables, `json` repeats column names on every row and can cost *more* tokens than the text table — use `json-compact` there. For narrow tables and schema output, `json` is smaller. `json-compact` only changes the row shape of `query` and `get_sample_data`; the other tools return identical JSON in both modes.

### Environment Variables

Avoid putting credentials in config files. Use env vars instead:

```bash
DB_URL=mysql://user:password@host:3306/mydb npx @salmanulfaris/sql-mcp
```

In MCP config files, you can pass env vars via the `env` field:

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "npx",
      "args": ["@salmanulfaris/sql-mcp"],
      "env": {
        "DB_URL": "mysql://user:password@host:3306/mydb"
      }
    }
  }
}
```

## Available Tools

| Tool | Description | Permission |
|---|---|---|
| `list_tables` | List all tables and views in the database | Read-only (default) |
| `describe_table` | Full schema for one table: columns, types, indexes, FK | Read-only (default) |
| `get_schema` | Full database schema dump | Read-only (default) |
| `get_sample_data` | Sample N rows from a table | Read-only (default) |
| `query` | Execute any SQL statement | Depends on statement type |
| `analyze_query` | Show execution plan + detect performance issues (full scans, missing indexes, filesort, etc.) | Always safe (plan-only by default) |

### `analyze_query` Usage

Use this when investigating slow queries or bad indexing. By default it only shows the planner's EXPLAIN output (no execution). Set `execute=true` for real timing on `SELECT` queries — bounded by `timeout_ms` (default 5s) so it never hangs on huge tables.

```js
// Plan-only (safe, always cheap)
analyze_query({ sql: "SELECT * FROM orders WHERE user_id = 123" })

// Real timing on SELECT (capped at 5s)
analyze_query({ sql: "SELECT COUNT(*) FROM orders", execute: true })

// Increase timeout for a slow analytics query
analyze_query({ sql: "SELECT ...", execute: true, timeout_ms: 30000 })
```

Output includes detected issues like `⚠ Full table scan on \`orders\`` or `⚠ Filesort — consider index on ORDER BY columns`.

The plan source is dialect-specific: `EXPLAIN`/`EXPLAIN ANALYZE` on MySQL and PostgreSQL, `EXPLAIN QUERY PLAN` on SQLite, and `SHOWPLAN_ALL` (plan-only) / `STATISTICS PROFILE` (`execute=true`) on SQL Server. SQL Server insights flag table/clustered-index scans, key lookups, sorts, hash joins, and estimate-vs-actual row skew.

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
.sql-mcp file / CLI args / env vars
       │
       ▼
  ServerConfig (permissions + connection)
       │
       ├── createDriver (mysql2 / pg / mssql / better-sqlite3)
       │
       └── McpServer
             ├── list_tables
             ├── describe_table
             ├── get_schema
             ├── get_sample_data
             ├── query ──► permissions.ts (classifier + gate)
             └── analyze_query
```

## Contributing

Contributions are welcome! Areas to contribute:

- **Add SQL statement types** — edit `src/permissions.ts`, add to `STATEMENT_MAP` and the `checkPermission` switch.
- **Add a new tool** — create `src/tools/your-tool.ts`, export a `registerYourTool(server, driver)` function, import and call it in `src/index.ts`.
- **Add database support** — create a new driver in `src/drivers/` implementing the `DatabaseDriver` interface.

### Development

```bash
git clone https://github.com/salmanulfaris/sql-mcp
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
