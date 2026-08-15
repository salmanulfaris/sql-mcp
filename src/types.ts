export interface PermissionConfig {
  allowWrite: boolean;
  allowDelete: boolean;
  allowDDL: boolean;
  allowDropDatabase: boolean;
}

export interface ConnectionConfig {
  uri: string;
  ssl: boolean;
}

export type OutputFormat = 'text' | 'json' | 'json-compact';

export interface ServerConfig {
  connection: ConnectionConfig;
  permissions: PermissionConfig;
  outputFormat: OutputFormat;
}

export type SqlStatementType =
  | 'SELECT'
  | 'SHOW'
  | 'DESCRIBE'
  | 'EXPLAIN'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'ALTER'
  | 'CREATE'
  | 'DROP'
  | 'TRUNCATE'
  | 'DROP_DATABASE'
  | 'UNKNOWN';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}
