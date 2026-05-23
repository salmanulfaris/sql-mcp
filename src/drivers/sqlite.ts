import Database from 'better-sqlite3';
import type {
  DatabaseDriver,
  Dialect,
  TableInfo,
  TableDescription,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  QueryResult,
  ExecuteQueryOptions,
} from './base.js';
import { isValidIdentifier } from '../permissions.js';

export class SqliteDriver implements DatabaseDriver {
  readonly dialect: Dialect = 'sqlite';
  private db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async testConnection(): Promise<void> {
    try {
      this.db.prepare('SELECT 1').get();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to open SQLite database: ${message}`);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string; type: string }[];
    return rows.map((r) => ({
      name: r.name,
      type: r.type === 'view' ? ('VIEW' as const) : ('TABLE' as const),
    }));
  }

  async describeTable(name: string): Promise<TableDescription> {
    if (!isValidIdentifier(name)) {
      throw new Error(`Invalid table name '${name}'`);
    }

    const colRows = this.db.prepare(`PRAGMA table_info("${name}")`).all() as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];

    if (colRows.length === 0) {
      throw new Error(`Table '${name}' does not exist`);
    }

    const idxList = this.db.prepare(`PRAGMA index_list("${name}")`).all() as {
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }[];

    const indexes: IndexInfo[] = [];
    const uniqueCols = new Set<string>();
    for (const idx of idxList) {
      const idxInfo = this.db.prepare(`PRAGMA index_info("${idx.name}")`).all() as {
        seqno: number;
        cid: number;
        name: string;
      }[];
      const columns = idxInfo.map((i) => i.name);
      indexes.push({ name: idx.name, unique: idx.unique === 1, columns });
      if (idx.unique === 1 && columns.length === 1) uniqueCols.add(columns[0]);
    }

    const fkRows = this.db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }[];

    const columns: ColumnInfo[] = colRows.map((row) => ({
      name: row.name,
      dataType: row.type || 'TEXT',
      nullable: row.notnull === 0,
      defaultValue: row.dflt_value,
      isPrimaryKey: row.pk > 0,
      isUnique: uniqueCols.has(row.name) && row.pk === 0,
      extra: '',
    }));

    const foreignKeys: ForeignKeyInfo[] = fkRows.map((row) => ({
      constraintName: `fk_${name}_${row.id}`,
      column: row.from,
      referencedTable: row.table,
      referencedColumn: row.to,
    }));

    return { name, columns, indexes, foreignKeys };
  }

  async getSchema(): Promise<TableDescription[]> {
    const tables = await this.listTables();
    const descriptions = await Promise.all(
      tables.filter((t) => t.type === 'TABLE').map((t) => this.describeTable(t.name)),
    );
    return descriptions;
  }

  async getSampleData(name: string, limit: number, orderBy?: string): Promise<QueryResult> {
    if (!isValidIdentifier(name)) {
      throw new Error(`Invalid table name '${name}'`);
    }
    const orderClause = orderBy ? `ORDER BY ${orderBy}` : '';
    const stmt = this.db.prepare(`SELECT * FROM "${name}" ${orderClause} LIMIT ?`);
    const rows = stmt.all(limit) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, columns };
  }

  async executeQuery(sql: string, opts: ExecuteQueryOptions): Promise<QueryResult> {
    let finalSql = sql;
    if (opts.isReadOnly && !/\bLIMIT\b/i.test(sql)) {
      finalSql = sql.trimEnd().replace(/;$/, '') + ` LIMIT ${opts.maxRows}`;
    }

    if (opts.isReadOnly) {
      const stmt = this.db.prepare(finalSql);
      const rows = stmt.all() as Record<string, unknown>[];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { rows, columns };
    } else {
      const result = this.db.prepare(finalSql).run();
      return {
        affectedRows: result.changes,
        insertId: result.lastInsertRowid !== 0n && result.lastInsertRowid !== 0 ? Number(result.lastInsertRowid) : undefined,
      };
    }
  }
}
