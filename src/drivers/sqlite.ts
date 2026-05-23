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
  AnalyzeOptions,
  AnalyzeResult,
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

  async analyzeQuery(sql: string, opts: AnalyzeOptions): Promise<AnalyzeResult> {
    const stripped = sql.trim().replace(/;$/, '');
    const timer = setTimeout(() => {
      try { (this.db as unknown as { interrupt?: () => void }).interrupt?.(); } catch {}
    }, opts.timeoutMs);

    try {
      const rows = this.db.prepare(`EXPLAIN QUERY PLAN ${stripped}`).all() as {
        id: number;
        parent: number;
        notused: number;
        detail: string;
      }[];

      const lines = this.buildSqliteTree(rows);
      const raw = lines.join('\n');
      return {
        raw,
        insights: this.sqliteInsights(rows),
        executed: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/interrupt/i.test(message)) {
        return { raw: '', insights: [], executed: false, timedOut: true };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildSqliteTree(rows: { id: number; parent: number; detail: string }[]): string[] {
    const childrenByParent = new Map<number, typeof rows>();
    for (const r of rows) {
      if (!childrenByParent.has(r.parent)) childrenByParent.set(r.parent, []);
      childrenByParent.get(r.parent)!.push(r);
    }
    const lines: string[] = [];
    const walk = (parent: number, depth: number) => {
      const kids = childrenByParent.get(parent) ?? [];
      for (const k of kids) {
        lines.push('  '.repeat(depth) + '└─ ' + k.detail);
        walk(k.id, depth + 1);
      }
    };
    walk(0, 0);
    return lines.length > 0 ? lines : rows.map((r) => r.detail);
  }

  private sqliteInsights(rows: { detail: string }[]): string[] {
    const insights: string[] = [];
    for (const r of rows) {
      const d = r.detail;
      const scanMatch = d.match(/^SCAN (\w+)/);
      if (scanMatch) insights.push(`⚠ Full table scan on \`${scanMatch[1]}\``);
      const searchMatch = d.match(/^SEARCH (\w+) USING INDEX (\S+)/);
      if (searchMatch) insights.push(`✓ Index lookup on \`${searchMatch[1]}\` via \`${searchMatch[2]}\``);
      if (/USE TEMP B-TREE FOR ORDER BY/i.test(d)) {
        insights.push('⚠ ORDER BY uses temporary B-tree — consider index on the sort columns');
      }
      if (/USE TEMP B-TREE FOR DISTINCT/i.test(d)) {
        insights.push('⚠ DISTINCT uses temporary B-tree — consider index on the distinct columns');
      }
      if (/USE TEMP B-TREE FOR GROUP BY/i.test(d)) {
        insights.push('⚠ GROUP BY uses temporary B-tree');
      }
    }
    return insights;
  }
}
