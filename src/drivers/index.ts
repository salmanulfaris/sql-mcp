import type { DatabaseDriver } from './base.js';
import { MySQLDriver } from './mysql.js';
import { PostgresDriver } from './postgres.js';
import { SqliteDriver } from './sqlite.js';
import { MSSQLDriver } from './mssql.js';

export type { DatabaseDriver } from './base.js';
export * from './base.js';

export function createDriver(uri: string, ssl: boolean): DatabaseDriver {
  if (uri.startsWith('mysql://') || uri.startsWith('mysql2://')) {
    return new MySQLDriver(uri, ssl);
  }
  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    return new PostgresDriver(uri, ssl);
  }
  if (uri.startsWith('mssql://') || uri.startsWith('sqlserver://')) {
    return new MSSQLDriver(uri, ssl);
  }
  if (uri.startsWith('sqlite:') || uri.startsWith('file:') || /\.(db|sqlite|sqlite3)$/i.test(uri)) {
    const path = uri.replace(/^(sqlite:|file:)/, '');
    return new SqliteDriver(path);
  }
  throw new Error(
    `Unsupported database URI: ${uri}\n` +
      `Supported schemes:\n` +
      `  mysql://user:pass@host:port/db\n` +
      `  postgres://user:pass@host:port/db (or postgresql://)\n` +
      `  mssql://user:pass@host:port/db (or sqlserver://)\n` +
      `  sqlite:./path/to/file.db (or file:./path or *.db/*.sqlite/*.sqlite3)`,
  );
}
