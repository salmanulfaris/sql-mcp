import mssql from 'mssql';
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

const LENGTH_TYPES = new Set([
  'varchar',
  'nvarchar',
  'char',
  'nchar',
  'varbinary',
  'binary',
]);

interface PlanRow {
  StmtText?: string;
  PhysicalOp?: string;
  LogicalOp?: string;
  Argument?: string;
  EstimateRows?: number;
  Rows?: number;
  Executes?: number;
}

export class MSSQLDriver implements DatabaseDriver {
  readonly dialect: Dialect = 'mssql';
  private pool: mssql.ConnectionPool;
  private connecting?: Promise<mssql.ConnectionPool>;

  constructor(uri: string, ssl: boolean) {
    this.pool = new mssql.ConnectionPool(this.buildConfig(uri, ssl));
  }

  private buildConfig(uri: string, ssl: boolean): mssql.config {
    const u = new URL(uri);
    const enc = u.searchParams.get('encrypt');
    const trust = u.searchParams.get('trustServerCertificate');
    return {
      server: decodeURIComponent(u.hostname),
      port: u.port ? Number(u.port) : 1433,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
      options: {
        // Default encryption to the --ssl flag; let URI query params override.
        encrypt: enc != null ? enc === 'true' : ssl,
        // When the user opts into SSL we validate the cert; otherwise trust it (local dev).
        trustServerCertificate: trust != null ? trust === 'true' : !ssl,
      },
    };
  }

  /** Connect once and reuse. node-mssql pools require an explicit connect(). */
  private ready(): Promise<mssql.ConnectionPool> {
    if (!this.connecting) this.connecting = this.pool.connect();
    return this.connecting;
  }

  async testConnection(): Promise<void> {
    try {
      const pool = await this.ready();
      await pool.request().query('SELECT 1');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect to SQL Server: ${message}`);
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  async listTables(): Promise<TableInfo[]> {
    const pool = await this.ready();
    const result = await pool.request().query<{ TABLE_NAME: string; TABLE_TYPE: string }>(
      `SELECT TABLE_NAME, TABLE_TYPE
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW') AND TABLE_SCHEMA = SCHEMA_NAME()
       ORDER BY TABLE_NAME`,
    );
    return result.recordset.map((r) => ({
      name: r.TABLE_NAME,
      type: r.TABLE_TYPE === 'VIEW' ? ('VIEW' as const) : ('TABLE' as const),
    }));
  }

  private buildType(dataType: string, length: number | null): string {
    if (length != null && LENGTH_TYPES.has(dataType.toLowerCase())) {
      return `${dataType}(${length === -1 ? 'max' : length})`;
    }
    return dataType;
  }

  async describeTable(name: string): Promise<TableDescription> {
    if (!isValidIdentifier(name)) {
      throw new Error(`Invalid table name '${name}'`);
    }
    const pool = await this.ready();

    const [colRes, pkRes, identRes, idxRes, fkRes] = await Promise.all([
      pool.request().input('name', name).query(
        `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_NAME = @name AND TABLE_SCHEMA = SCHEMA_NAME()
         ORDER BY ORDINAL_POSITION`,
      ),
      pool.request().input('name', name).query(
        `SELECT kcu.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = @name
           AND tc.TABLE_SCHEMA = SCHEMA_NAME()`,
      ),
      pool.request().input('name', name).query(
        `SELECT c.name FROM sys.columns c
         WHERE c.object_id = OBJECT_ID(QUOTENAME(SCHEMA_NAME()) + '.' + QUOTENAME(@name))
           AND c.is_identity = 1`,
      ),
      pool.request().input('name', name).query(
        `SELECT i.name AS index_name, i.is_unique, c.name AS column_name, ic.key_ordinal
         FROM sys.indexes i
         JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
         JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
         WHERE i.object_id = OBJECT_ID(QUOTENAME(SCHEMA_NAME()) + '.' + QUOTENAME(@name))
           AND i.name IS NOT NULL AND ic.is_included_column = 0
         ORDER BY i.name, ic.key_ordinal`,
      ),
      pool.request().input('name', name).query(
        `SELECT fk.name AS constraint_name, cpa.name AS column_name,
                rt.name AS referenced_table, cref.name AS referenced_column
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
         JOIN sys.tables t ON fk.parent_object_id = t.object_id
         JOIN sys.columns cpa ON fkc.parent_object_id = cpa.object_id AND fkc.parent_column_id = cpa.column_id
         JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
         JOIN sys.columns cref ON fkc.referenced_object_id = cref.object_id AND fkc.referenced_column_id = cref.column_id
         WHERE t.name = @name AND t.schema_id = SCHEMA_ID(SCHEMA_NAME())
         ORDER BY fk.name, fkc.constraint_column_id`,
      ),
    ]);

    if (colRes.recordset.length === 0) {
      throw new Error(`Table '${name}' does not exist`);
    }

    const pkColumns = new Set(pkRes.recordset.map((r) => r.COLUMN_NAME));
    const identityColumns = new Set(identRes.recordset.map((r) => r.name));

    const indexMap = new Map<string, { unique: boolean; columns: string[] }>();
    for (const row of idxRes.recordset) {
      if (!indexMap.has(row.index_name)) {
        indexMap.set(row.index_name, { unique: row.is_unique, columns: [] });
      }
      indexMap.get(row.index_name)!.columns.push(row.column_name);
    }
    const uniqueCols = new Set<string>();
    for (const info of indexMap.values()) {
      if (info.unique && info.columns.length === 1) uniqueCols.add(info.columns[0]);
    }
    const indexes: IndexInfo[] = Array.from(indexMap, ([idxName, info]) => ({
      name: idxName,
      unique: info.unique,
      columns: info.columns,
    }));

    const columns: ColumnInfo[] = colRes.recordset.map((row) => ({
      name: row.COLUMN_NAME,
      dataType: this.buildType(row.DATA_TYPE, row.CHARACTER_MAXIMUM_LENGTH),
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      isPrimaryKey: pkColumns.has(row.COLUMN_NAME),
      isUnique: uniqueCols.has(row.COLUMN_NAME) && !pkColumns.has(row.COLUMN_NAME),
      extra: identityColumns.has(row.COLUMN_NAME) ? 'IDENTITY' : '',
    }));

    const foreignKeys: ForeignKeyInfo[] = fkRes.recordset.map((row) => ({
      constraintName: row.constraint_name,
      column: row.column_name,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column,
    }));

    return { name, columns, indexes, foreignKeys };
  }

  async getSchema(): Promise<TableDescription[]> {
    const pool = await this.ready();
    const [colRes, identRes, fkRes] = await Promise.all([
      pool.request().query(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH,
                IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = SCHEMA_NAME()
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      ),
      pool.request().query(
        `SELECT t.name AS table_name, c.name AS column_name
         FROM sys.columns c
         JOIN sys.tables t ON c.object_id = t.object_id
         WHERE c.is_identity = 1 AND t.schema_id = SCHEMA_ID(SCHEMA_NAME())`,
      ),
      pool.request().query(
        `SELECT t.name AS table_name, cpa.name AS column_name, fk.name AS constraint_name,
                rt.name AS referenced_table, cref.name AS referenced_column
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
         JOIN sys.tables t ON fk.parent_object_id = t.object_id
         JOIN sys.columns cpa ON fkc.parent_object_id = cpa.object_id AND fkc.parent_column_id = cpa.column_id
         JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
         JOIN sys.columns cref ON fkc.referenced_object_id = cref.object_id AND fkc.referenced_column_id = cref.column_id
         WHERE t.schema_id = SCHEMA_ID(SCHEMA_NAME())`,
      ),
    ]);

    const identitySet = new Set(
      identRes.recordset.map((r) => `${r.table_name}.${r.column_name}`),
    );

    const tableMap = new Map<string, TableDescription>();
    for (const row of colRes.recordset) {
      if (!tableMap.has(row.TABLE_NAME)) {
        tableMap.set(row.TABLE_NAME, { name: row.TABLE_NAME, columns: [], indexes: [], foreignKeys: [] });
      }
      tableMap.get(row.TABLE_NAME)!.columns.push({
        name: row.COLUMN_NAME,
        dataType: this.buildType(row.DATA_TYPE, row.CHARACTER_MAXIMUM_LENGTH),
        nullable: row.IS_NULLABLE === 'YES',
        defaultValue: row.COLUMN_DEFAULT,
        isPrimaryKey: false,
        isUnique: false,
        extra: identitySet.has(`${row.TABLE_NAME}.${row.COLUMN_NAME}`) ? 'IDENTITY' : '',
      });
    }
    for (const row of fkRes.recordset) {
      tableMap.get(row.table_name)?.foreignKeys.push({
        constraintName: row.constraint_name,
        column: row.column_name,
        referencedTable: row.referenced_table,
        referencedColumn: row.referenced_column,
      });
    }
    return Array.from(tableMap.values());
  }

  async getSampleData(name: string, limit: number, orderBy?: string): Promise<QueryResult> {
    if (!isValidIdentifier(name)) {
      throw new Error(`Invalid table name '${name}'`);
    }
    const pool = await this.ready();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const orderClause = orderBy ? `ORDER BY ${orderBy}` : '';
    const result = await pool
      .request()
      .query(`SELECT TOP (${safeLimit}) * FROM [${name}] ${orderClause}`);
    return {
      rows: result.recordset as Record<string, unknown>[],
      columns: this.columnNames(result),
    };
  }

  async executeQuery(sql: string, opts: ExecuteQueryOptions): Promise<QueryResult> {
    const pool = await this.ready();
    let finalSql = sql.trim().replace(/;$/, '');
    // MSSQL has no LIMIT — inject TOP into bare SELECTs to bound read-only results.
    if (
      opts.isReadOnly &&
      /^SELECT\b/i.test(finalSql) &&
      !/\bTOP\b/i.test(finalSql) &&
      !/\bOFFSET\b/i.test(finalSql)
    ) {
      finalSql = finalSql.replace(/^(SELECT\s+(?:DISTINCT\s+)?)/i, `$1TOP (${opts.maxRows}) `);
    }
    const result = await pool.request().query(finalSql);
    if (opts.isReadOnly) {
      const rows = (result.recordset ?? []) as Record<string, unknown>[];
      return { rows, columns: this.columnNames(result, rows) };
    }
    const affected = Array.isArray(result.rowsAffected)
      ? result.rowsAffected.reduce((a, b) => a + b, 0)
      : 0;
    return { affectedRows: affected };
  }

  private columnNames(result: mssql.IResult<unknown>, rows?: Record<string, unknown>[]): string[] {
    if (result.recordset?.columns) {
      return Object.keys(result.recordset.columns);
    }
    const r = rows ?? (result.recordset as Record<string, unknown>[] | undefined);
    return r && r[0] ? Object.keys(r[0]) : [];
  }

  async analyzeQuery(sql: string, opts: AnalyzeOptions): Promise<AnalyzeResult> {
    const stripped = sql.trim().replace(/;$/, '');
    const pool = await this.ready();

    if (opts.execute) {
      // STATISTICS PROFILE runs the query and returns the actual plan as an extra recordset.
      const request = pool.request();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          request.cancel();
        } catch {
          /* ignore */
        }
      }, opts.timeoutMs);
      try {
        const result = await request.batch(
          `SET STATISTICS PROFILE ON; ${stripped}; SET STATISTICS PROFILE OFF;`,
        );
        const planRows = this.findPlanRecordset(result.recordsets as unknown as PlanRow[][]);
        return {
          raw: this.formatPlan(planRows, true),
          insights: this.mssqlInsights(planRows, true),
          executed: true,
        };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (timedOut || code === 'ECANCEL') {
          return { raw: '', insights: [], executed: true, timedOut: true };
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    // Plan-only: SHOWPLAN_ALL must be alone in its batch and shares session state with
    // the analyzed query, so we pin a single connection with a transaction.
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try {
      await new mssql.Request(tx).batch('SET SHOWPLAN_ALL ON');
      const planResult = await new mssql.Request(tx).batch(stripped);
      await new mssql.Request(tx).batch('SET SHOWPLAN_ALL OFF');
      await tx.commit();
      const planRows = (planResult.recordset ?? []) as unknown as PlanRow[];
      return {
        raw: this.formatPlan(planRows, false),
        insights: this.mssqlInsights(planRows, false),
        executed: false,
      };
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** Pick the recordset that carries the execution plan (the one with PhysicalOp/StmtText). */
  private findPlanRecordset(recordsets: PlanRow[][]): PlanRow[] {
    let best: PlanRow[] = [];
    for (const rs of recordsets ?? []) {
      if (Array.isArray(rs) && rs.length && ('PhysicalOp' in rs[0] || 'StmtText' in rs[0])) {
        if (rs.length > best.length) best = rs;
      }
    }
    return best;
  }

  private formatPlan(rows: PlanRow[], executed: boolean): string {
    if (!rows.length) return '(no plan returned)';
    return rows
      .filter((r) => r.StmtText != null)
      .map((r) => {
        const txt = String(r.StmtText).replace(/\s+$/, '');
        if (executed && r.PhysicalOp != null && r.Rows != null) {
          return `${txt}   [actual rows=${r.Rows}, executes=${r.Executes ?? 0}]`;
        }
        return txt;
      })
      .join('\n');
  }

  private mssqlInsights(rows: PlanRow[], executed: boolean): string[] {
    const insights: string[] = [];
    for (const r of rows) {
      const op = String(r.PhysicalOp ?? '');
      const arg = String(r.Argument ?? '');
      const est = Number(r.EstimateRows ?? 0);
      const actual = Number(r.Rows ?? 0);
      const tblMatch = arg.match(/OBJECT:\(\[[^\]]*\]\.\[[^\]]*\]\.\[([^\]]+)\]/);
      const tbl = tblMatch ? `\`${tblMatch[1]}\`` : '';
      const on = tbl ? ` on ${tbl}` : '';

      if (/Table Scan/i.test(op)) {
        insights.push(`⚠ Table scan${on} — heap with no usable index`);
      } else if (/Clustered Index Scan/i.test(op)) {
        insights.push(`⚠ Clustered index scan${on} — scanning the whole table`);
      } else if (/Index Scan/i.test(op)) {
        insights.push(`↳ Index scan${on} — not a seek; check WHERE/SARGability`);
      }
      if (/Key Lookup|RID Lookup/i.test(op)) {
        insights.push(`⚠ ${op}${on} — a covering index could eliminate lookups`);
      }
      if (/Hash Match/i.test(op)) {
        insights.push('↳ Hash match join/aggregate — large unindexed join or grouping');
      }
      if (/Sort/i.test(op)) {
        insights.push('⚠ Sort operator — consider an index matching ORDER BY/GROUP BY');
      }
      if (est > 10000 && /Scan/i.test(op)) {
        insights.push(`⚠ Estimated ${Math.round(est)} rows scanned${on} — review WHERE/JOIN`);
      }
      if (executed && est > 0 && actual > 0 && (actual > est * 10 || est > actual * 10)) {
        insights.push(
          `⚠ Estimate skew${on}: estimated ${Math.round(est)} vs actual ${actual} rows — stats may be stale (run UPDATE STATISTICS)`,
        );
      }
    }
    return [...new Set(insights)];
  }
}
