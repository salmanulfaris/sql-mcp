export type Dialect = 'mysql' | 'postgres' | 'sqlite' | 'mssql';

export interface TableInfo {
  name: string;
  type: 'TABLE' | 'VIEW';
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isUnique: boolean;
  extra: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface ForeignKeyInfo {
  constraintName: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface TableDescription {
  name: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface QueryResult {
  rows?: Record<string, unknown>[];
  affectedRows?: number;
  insertId?: number | string;
  columns?: string[];
}

export interface ExecuteQueryOptions {
  isReadOnly: boolean;
  // Whether to append a bounding LIMIT/TOP to cap result size. True only for plain
  // SELECTs — not SHOW/DESCRIBE/EXPLAIN, which do not accept a row limit and whose
  // output is already small.
  appendLimit: boolean;
  maxRows: number;
}

export interface AnalyzeOptions {
  execute: boolean;
  timeoutMs: number;
}

export interface AnalyzeResult {
  raw: string;
  insights: string[];
  executed: boolean;
  timedOut?: boolean;
}

export interface DatabaseDriver {
  readonly dialect: Dialect;
  testConnection(): Promise<void>;
  close(): Promise<void>;
  listTables(): Promise<TableInfo[]>;
  describeTable(name: string): Promise<TableDescription>;
  getSchema(): Promise<TableDescription[]>;
  getSampleData(name: string, limit: number, orderBy?: string): Promise<QueryResult>;
  executeQuery(sql: string, opts: ExecuteQueryOptions): Promise<QueryResult>;
  analyzeQuery(sql: string, opts: AnalyzeOptions): Promise<AnalyzeResult>;
}
