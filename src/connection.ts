import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import type { ConnectionConfig } from './types.js';

export function createConnectionPool(config: ConnectionConfig): Pool {
  return mysql.createPool({
    uri: config.uri,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

export async function testConnection(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to MySQL: ${message}`);
  }
}
