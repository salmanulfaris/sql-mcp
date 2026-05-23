import type { PermissionConfig, SqlStatementType } from './types.js';

const STATEMENT_MAP: Record<string, SqlStatementType> = {
  SELECT: 'SELECT',
  SHOW: 'SHOW',
  DESCRIBE: 'DESCRIBE',
  DESC: 'DESCRIBE',
  EXPLAIN: 'EXPLAIN',
  INSERT: 'INSERT',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  ALTER: 'ALTER',
  CREATE: 'CREATE',
  DROP: 'DROP',
  TRUNCATE: 'TRUNCATE',
};

function stripComments(sql: string): string {
  // Strip /* ... */ block comments
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Strip -- line comments
  result = result.replace(/--[^\n]*/g, ' ');
  // Strip # line comments (MySQL-specific)
  result = result.replace(/#[^\n]*/g, ' ');
  return result.trim();
}

export function classifySqlStatement(sql: string): SqlStatementType {
  const stripped = stripComments(sql).replace(/\s+/g, ' ').trim();
  const words = stripped.split(' ').filter(Boolean);

  if (words.length === 0) return 'UNKNOWN';

  const first = words[0].toUpperCase();

  if (first === 'DROP') {
    const second = words[1]?.toUpperCase();
    if (second === 'DATABASE' || second === 'SCHEMA') {
      return 'DROP_DATABASE';
    }
    return 'DROP';
  }

  return STATEMENT_MAP[first] ?? 'UNKNOWN';
}

export function checkPermission(
  statementType: SqlStatementType,
  permissions: PermissionConfig,
): { allowed: boolean; reason?: string } {
  const readOnly: SqlStatementType[] = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN'];

  if (readOnly.includes(statementType)) {
    return { allowed: true };
  }

  if (statementType === 'UNKNOWN') {
    return {
      allowed: false,
      reason:
        'Unrecognized or disallowed SQL statement. Only SELECT, SHOW, DESCRIBE, EXPLAIN, and explicitly enabled write operations are permitted.',
    };
  }

  if (statementType === 'DROP_DATABASE') {
    if (permissions.allowDropDatabase) return { allowed: true };
    return {
      allowed: false,
      reason: 'DROP DATABASE is prohibited. Use --allow-drop-database to explicitly enable it.',
    };
  }

  if (statementType === 'INSERT' || statementType === 'UPDATE') {
    if (permissions.allowWrite) return { allowed: true };
    return {
      allowed: false,
      reason: 'Write operations are disabled. Use --allow-write to enable INSERT and UPDATE.',
    };
  }

  if (statementType === 'DELETE') {
    if (permissions.allowDelete) return { allowed: true };
    return {
      allowed: false,
      reason: 'DELETE is disabled. Use --allow-delete to enable it.',
    };
  }

  if (
    statementType === 'ALTER' ||
    statementType === 'CREATE' ||
    statementType === 'DROP' ||
    statementType === 'TRUNCATE'
  ) {
    if (permissions.allowDDL) return { allowed: true };
    return {
      allowed: false,
      reason:
        'DDL operations are disabled. Use --allow-ddl to enable ALTER, CREATE, DROP, and TRUNCATE.',
    };
  }

  return { allowed: false, reason: 'Statement type not permitted.' };
}

export function hasMultipleStatements(sql: string): boolean {
  const stripped = stripComments(sql);
  // A semicolon that is not the very last non-whitespace character indicates multiple statements
  const trimmed = stripped.trimEnd();
  const withoutTrailingSemi = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
  return withoutTrailingSemi.includes(';');
}

export function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(name);
}
