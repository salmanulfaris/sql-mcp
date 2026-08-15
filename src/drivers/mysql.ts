import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
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
import { formatTable } from '../format.js';

export class MySQLDriver implements DatabaseDriver {
  readonly dialect: Dialect = 'mysql';
  private pool: Pool;

  constructor(uri: string, ssl: boolean) {
    this.pool = mysql.createPool({
      uri,
      // Return DATE/DATETIME/TIMESTAMP as strings exactly as stored, instead of
      // JS Date objects. Avoids String(Date) rendering "... GMT+0300 (Arabian
      // Standard Time)" and the UTC day-shift that toISOString() would cause on
      // bare DATE values.
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    });
  }

  async testConnection(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect to MySQL: ${message}`);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listTables(): Promise<TableInfo[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SHOW FULL TABLES');
    return rows.map((row) => {
      const values = Object.values(row) as string[];
      return {
        name: values[0],
        type: values[1] === 'VIEW' ? ('VIEW' as const) : ('TABLE' as const),
      };
    });
  }

  async describeTable(name: string): Promise<TableDescription> {
    if (!isValidIdentifier(name)) {
      throw new Error(`Invalid table name '${name}'`);
    }

    const [colRows, indexRows, fkRows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(`DESCRIBE \`${name}\``),
      this.pool.query<RowDataPacket[]>(`SHOW INDEX FROM \`${name}\``),
      this.pool.execute<RowDataPacket[]>(
        `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
        [name],
      ),
    ]);

    const columns: ColumnInfo[] = colRows[0].map((row) => ({
      name: row.Field,
      dataType: row.Type,
      nullable: row.Null === 'YES',
      defaultValue: row.Default,
      isPrimaryKey: row.Key === 'PRI',
      isUnique: row.Key === 'UNI',
      extra: (row.Extra || '').toUpperCase(),
    }));

    const indexMap = new Map<string, { unique: boolean; columns: string[] }>();
    for (const row of indexRows[0]) {
      if (!indexMap.has(row.Key_name)) {
        indexMap.set(row.Key_name, { unique: row.Non_unique === 0, columns: [] });
      }
      indexMap.get(row.Key_name)!.columns[row.Seq_in_index - 1] = row.Column_name;
    }
    const indexes: IndexInfo[] = Array.from(indexMap, ([name, info]) => ({
      name,
      unique: info.unique,
      columns: info.columns,
    }));

    const foreignKeys: ForeignKeyInfo[] = fkRows[0].map((row) => ({
      constraintName: row.CONSTRAINT_NAME,
      column: row.COLUMN_NAME,
      referencedTable: row.REFERENCED_TABLE_NAME,
      referencedColumn: row.REFERENCED_COLUMN_NAME,
    }));

    return { name, columns, indexes, foreignKeys };
  }

  async getSchema(): Promise<TableDescription[]> {
    const [colResult, fkResult] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT,
                IS_NULLABLE, COLUMN_TYPE, COLUMN_KEY, EXTRA
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
      ),
    ]);

    const tableMap = new Map<string, TableDescription>();
    for (const row of colResult[0]) {
      if (!tableMap.has(row.TABLE_NAME)) {
        tableMap.set(row.TABLE_NAME, { name: row.TABLE_NAME, columns: [], indexes: [], foreignKeys: [] });
      }
      tableMap.get(row.TABLE_NAME)!.columns.push({
        name: row.COLUMN_NAME,
        dataType: row.COLUMN_TYPE,
        nullable: row.IS_NULLABLE === 'YES',
        defaultValue: row.COLUMN_DEFAULT,
        isPrimaryKey: row.COLUMN_KEY === 'PRI',
        isUnique: row.COLUMN_KEY === 'UNI',
        extra: (row.EXTRA || '').toUpperCase(),
      });
    }
    for (const row of fkResult[0]) {
      tableMap.get(row.TABLE_NAME)?.foreignKeys.push({
        constraintName: row.CONSTRAINT_NAME,
        column: row.COLUMN_NAME,
        referencedTable: row.REFERENCED_TABLE_NAME,
        referencedColumn: row.REFERENCED_COLUMN_NAME,
      });
    }
    return Array.from(tableMap.values());
  }

  async getSampleData(name: string, limit: number, orderBy?: string): Promise<QueryResult> {
    if (!isValidIdentifier(name)) {
      throw new Error(`Invalid table name '${name}'`);
    }
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const orderClause = orderBy ? `ORDER BY ${orderBy}` : '';
    const [rows, fields] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM \`${name}\` ${orderClause} LIMIT ${safeLimit}`,
    );
    return {
      rows: rows as Record<string, unknown>[],
      columns: fields.map((f) => f.name),
    };
  }

  async executeQuery(sql: string, opts: ExecuteQueryOptions): Promise<QueryResult> {
    let finalSql = sql;
    if (opts.appendLimit && !/\bLIMIT\b/i.test(sql)) {
      finalSql = sql.trimEnd().replace(/;$/, '') + ` LIMIT ${opts.maxRows}`;
    }
    const [result, fields] = await this.pool.query(finalSql);
    if (opts.isReadOnly) {
      const rows = result as RowDataPacket[];
      return {
        rows: rows as Record<string, unknown>[],
        columns: Array.isArray(fields) ? fields.map((f) => f.name) : Object.keys(rows[0] ?? {}),
      };
    } else {
      const header = result as ResultSetHeader;
      return {
        affectedRows: header.affectedRows,
        insertId: header.insertId > 0 ? header.insertId : undefined,
      };
    }
  }

  async analyzeQuery(sql: string, opts: AnalyzeOptions): Promise<AnalyzeResult> {
    const stripped = sql.trim().replace(/;$/, '');
    let explainSql: string;
    let executed = false;

    if (opts.execute) {
      // Inject MAX_EXECUTION_TIME hint into the inner SELECT
      const withHint = stripped.replace(
        /^(SELECT)\s+/i,
        `$1 /*+ MAX_EXECUTION_TIME(${opts.timeoutMs}) */ `,
      );
      explainSql = `EXPLAIN ANALYZE ${withHint}`;
      executed = true;
    } else {
      explainSql = `EXPLAIN FORMAT=TRADITIONAL ${stripped}`;
    }

    try {
      const [result] = await this.pool.query(explainSql);
      const rows = result as RowDataPacket[];

      if (executed) {
        // EXPLAIN ANALYZE returns a single column "EXPLAIN" with tree text
        const treeText = rows.map((r) => Object.values(r)[0]).join('\n');
        return {
          raw: treeText,
          insights: this.mysqlInsightsFromTree(treeText),
          executed: true,
        };
      }

      const rawTable = formatTable(rows as Record<string, unknown>[]);
      return {
        raw: rawTable,
        insights: this.mysqlInsightsFromTable(rows),
        executed: false,
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      // Timeout via MAX_EXECUTION_TIME hint
      if (code === 'ER_QUERY_TIMEOUT' || /max_statement_time|execution_time/i.test(message)) {
        return {
          raw: '',
          insights: [],
          executed: true,
          timedOut: true,
        };
      }
      // Fall back to EXPLAIN if EXPLAIN ANALYZE unsupported (< 8.0.18)
      if (executed && (code === 'ER_PARSE_ERROR' || /EXPLAIN ANALYZE/i.test(message))) {
        const [result] = await this.pool.query(`EXPLAIN FORMAT=TRADITIONAL ${stripped}`);
        const rows = result as RowDataPacket[];
        const rawTable = formatTable(rows as Record<string, unknown>[]);
        return {
          raw: rawTable + '\n\n(Note: EXPLAIN ANALYZE requires MySQL 8.0.18+. Showed plan-only output.)',
          insights: this.mysqlInsightsFromTable(rows),
          executed: false,
        };
      }
      throw err;
    }
  }

  private mysqlInsightsFromTable(rows: RowDataPacket[]): string[] {
    const insights: string[] = [];
    for (const row of rows) {
      const table = (row.table as string) || '?';
      const type = (row.type as string) || '';
      const key = row.key as string | null;
      const extra = (row.Extra as string) || '';
      const rowsExamined = Number(row.rows ?? 0);

      if (type === 'ALL') {
        insights.push(`⚠ Full table scan on \`${table}\` (examines ~${rowsExamined} rows)`);
      } else if (type === 'index') {
        insights.push(`↳ Full index scan on \`${table}\` — slow for large indexes`);
      }
      if (!key && type !== 'const' && type !== 'system' && type !== 'NULL') {
        insights.push(`⚠ No index used on \`${table}\` (type=${type})`);
      }
      if (extra.includes('Using filesort')) {
        insights.push(`⚠ Filesort on \`${table}\` — consider index on ORDER BY columns`);
      }
      if (extra.includes('Using temporary')) {
        insights.push(`⚠ Temporary table used on \`${table}\` — usually GROUP BY/DISTINCT without index`);
      }
      if (rowsExamined > 10000 && ['ALL', 'index', 'range'].includes(type)) {
        insights.push(`⚠ Scans ${rowsExamined} rows on \`${table}\` — review WHERE/JOIN conditions`);
      }
    }
    return insights;
  }

  private mysqlInsightsFromTree(tree: string): string[] {
    const insights: string[] = [];
    if (/Table scan on /i.test(tree)) {
      const matches = tree.match(/Table scan on (\w+)/gi) ?? [];
      for (const m of matches) {
        const name = m.replace(/^Table scan on /i, '');
        insights.push(`⚠ Full table scan on \`${name}\``);
      }
    }
    if (/Filesort/i.test(tree)) insights.push('⚠ Filesort detected in execution');
    if (/Temporary table/i.test(tree)) insights.push('⚠ Temporary table used during execution');
    const slowMatches = tree.match(/actual time=[\d.]+\.\.([\d.]+)/g) ?? [];
    for (const m of slowMatches) {
      const ms = Number(m.split('..')[1]);
      if (ms > 1000) {
        insights.push(`⚠ Step took ${ms.toFixed(1)}ms (slow)`);
        break;
      }
    }
    return insights;
  }
}
