import pg from 'pg';
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

const { Pool } = pg;

export class PostgresDriver implements DatabaseDriver {
  readonly dialect: Dialect = 'postgres';
  private pool: pg.Pool;

  constructor(uri: string, ssl: boolean) {
    this.pool = new Pool({
      connectionString: uri,
      max: 10,
      keepAlive: true,
      ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    });
  }

  async testConnection(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect to PostgreSQL: ${message}`);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listTables(): Promise<TableInfo[]> {
    const { rows } = await this.pool.query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY table_name`,
    );
    return rows.map((r) => ({
      name: r.table_name,
      type: r.table_type === 'VIEW' ? ('VIEW' as const) : ('TABLE' as const),
    }));
  }

  async describeTable(name: string): Promise<TableDescription> {
    if (!isValidIdentifier(name)) {
      throw new Error(`Invalid table name '${name}'`);
    }

    const [colRes, idxRes, fkRes] = await Promise.all([
      this.pool.query(
        `SELECT column_name, data_type, udt_name, character_maximum_length,
                is_nullable, column_default, ordinal_position
         FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1
         ORDER BY ordinal_position`,
        [name],
      ),
      this.pool.query(
        `SELECT i.relname AS index_name, ix.indisunique AS is_unique,
                a.attname AS column_name, k.ordinal AS seq
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ordinal) ON true
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         WHERE n.nspname = current_schema() AND t.relname = $1
         ORDER BY i.relname, k.ordinal`,
        [name],
      ),
      this.pool.query(
        `SELECT kcu.constraint_name, kcu.column_name,
                ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
         FROM information_schema.key_column_usage kcu
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
         WHERE kcu.table_schema = current_schema() AND kcu.table_name = $1
         ORDER BY kcu.constraint_name, kcu.ordinal_position`,
        [name],
      ),
    ]);

    // Get primary key columns
    const pkRes = await this.pool.query(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relname = $1 AND i.indisprimary`,
      [name],
    );
    const pkColumns = new Set(pkRes.rows.map((r) => r.attname));

    const columns: ColumnInfo[] = colRes.rows.map((row) => {
      const dataType = row.character_maximum_length
        ? `${row.data_type}(${row.character_maximum_length})`
        : row.udt_name || row.data_type;
      return {
        name: row.column_name,
        dataType,
        nullable: row.is_nullable === 'YES',
        defaultValue: row.column_default,
        isPrimaryKey: pkColumns.has(row.column_name),
        isUnique: false,
        extra: row.column_default?.includes('nextval') ? 'AUTO_INCREMENT' : '',
      };
    });

    // Mark unique columns based on unique indexes with single column
    const uniqueByIdx = new Map<string, { unique: boolean; columns: string[] }>();
    for (const row of idxRes.rows) {
      if (!uniqueByIdx.has(row.index_name)) {
        uniqueByIdx.set(row.index_name, { unique: row.is_unique, columns: [] });
      }
      uniqueByIdx.get(row.index_name)!.columns.push(row.column_name);
    }
    for (const info of uniqueByIdx.values()) {
      if (info.unique && info.columns.length === 1) {
        const col = columns.find((c) => c.name === info.columns[0]);
        if (col && !col.isPrimaryKey) col.isUnique = true;
      }
    }
    const indexes: IndexInfo[] = Array.from(uniqueByIdx, ([name, info]) => ({
      name,
      unique: info.unique,
      columns: info.columns,
    }));

    const foreignKeys: ForeignKeyInfo[] = fkRes.rows.map((row) => ({
      constraintName: row.constraint_name,
      column: row.column_name,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column,
    }));

    return { name, columns, indexes, foreignKeys };
  }

  async getSchema(): Promise<TableDescription[]> {
    const [colRes, fkRes] = await Promise.all([
      this.pool.query(
        `SELECT table_name, column_name, data_type, udt_name, character_maximum_length,
                is_nullable, column_default, ordinal_position
         FROM information_schema.columns
         WHERE table_schema = current_schema()
         ORDER BY table_name, ordinal_position`,
      ),
      this.pool.query(
        `SELECT kcu.table_name, kcu.column_name, kcu.constraint_name,
                ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
         FROM information_schema.key_column_usage kcu
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
         WHERE kcu.table_schema = current_schema()`,
      ),
    ]);

    const tableMap = new Map<string, TableDescription>();
    for (const row of colRes.rows) {
      if (!tableMap.has(row.table_name)) {
        tableMap.set(row.table_name, { name: row.table_name, columns: [], indexes: [], foreignKeys: [] });
      }
      const dataType = row.character_maximum_length
        ? `${row.data_type}(${row.character_maximum_length})`
        : row.udt_name || row.data_type;
      tableMap.get(row.table_name)!.columns.push({
        name: row.column_name,
        dataType,
        nullable: row.is_nullable === 'YES',
        defaultValue: row.column_default,
        isPrimaryKey: false,
        isUnique: false,
        extra: row.column_default?.includes('nextval') ? 'AUTO_INCREMENT' : '',
      });
    }
    for (const row of fkRes.rows) {
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
    const orderClause = orderBy ? `ORDER BY ${orderBy}` : '';
    const result = await this.pool.query(`SELECT * FROM "${name}" ${orderClause} LIMIT $1`, [limit]);
    return {
      rows: result.rows,
      columns: result.fields.map((f) => f.name),
    };
  }

  async executeQuery(sql: string, opts: ExecuteQueryOptions): Promise<QueryResult> {
    let finalSql = sql;
    if (opts.appendLimit && !/\bLIMIT\b/i.test(sql)) {
      finalSql = sql.trimEnd().replace(/;$/, '') + ` LIMIT ${opts.maxRows}`;
    }
    const result = await this.pool.query(finalSql);
    if (opts.isReadOnly) {
      return {
        rows: result.rows,
        columns: result.fields.map((f) => f.name),
      };
    } else {
      return { affectedRows: result.rowCount ?? 0 };
    }
  }

  async analyzeQuery(sql: string, opts: AnalyzeOptions): Promise<AnalyzeResult> {
    const stripped = sql.trim().replace(/;$/, '');

    if (!opts.execute) {
      const result = await this.pool.query(`EXPLAIN ${stripped}`);
      const raw = result.rows.map((r) => r['QUERY PLAN']).join('\n');
      return {
        raw,
        insights: this.postgresInsights(raw),
        executed: false,
      };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${opts.timeoutMs}`);
      const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${stripped}`);
      await client.query('COMMIT');
      const raw = result.rows.map((r) => r['QUERY PLAN']).join('\n');
      return {
        raw,
        insights: this.postgresInsights(raw),
        executed: true,
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      const code = (err as { code?: string }).code;
      if (code === '57014') {
        return {
          raw: '',
          insights: [],
          executed: true,
          timedOut: true,
        };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private postgresInsights(plan: string): string[] {
    const insights: string[] = [];
    const lines = plan.split('\n');
    for (const line of lines) {
      const seqMatch = line.match(/Seq Scan on (\w+)/);
      if (seqMatch) insights.push(`⚠ Sequential scan on \`${seqMatch[1]}\``);
      if (/Sort Method: external merge/i.test(line)) {
        insights.push('⚠ Sort spilled to disk — consider increasing work_mem');
      }
      const filterMatch = line.match(/Rows Removed by Filter:\s*(\d+)/);
      if (filterMatch && Number(filterMatch[1]) > 1000) {
        insights.push(`⚠ Filter discarded ${filterMatch[1]} rows — index on the filter column may help`);
      }
      const heapMatch = line.match(/Heap Fetches:\s*(\d+)/);
      if (heapMatch && Number(heapMatch[1]) > 0 && /Index Only Scan/i.test(plan)) {
        insights.push(`↳ Index-only scan but VACUUM needed (heap fetches: ${heapMatch[1]})`);
      }
    }
    return insights;
  }
}
