import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = resolve(fileURLToPath(new URL('../../database/migrations/', import.meta.url)));

/**
 * Minimal Cloudflare D1 stand-in backed by a real in-memory SQLite database.
 * It lets repository tests execute the production SQL and the real migrations
 * instead of asserting on strings through a fake. Same contract as D1:
 * prepare().bind().all()/first()/run(), plus batch() as one transaction.
 */
export function createSqliteD1({ migrations = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  if (migrations) {
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'));
    }
  }

  const log = [];
  const execute = (sql, params, mode) => {
    log.push({ sql, params });
    const statement = sqlite.prepare(sql);
    if (mode === 'run' && !/\bRETURNING\b/iu.test(sql)) {
      const info = statement.run(...params);
      return { success: true, meta: { changes: Number(info.changes) } };
    }
    const rows = statement.all(...params).map((row) => ({ ...row }));
    return { success: true, results: rows, meta: { changes: rows.length } };
  };

  const prepare = (sql) => {
    let params = [];
    const statement = {
      bind(...values) { params = values; return statement; },
      async all() { return execute(sql, params, 'all'); },
      async first() { return execute(sql, params, 'all').results[0] ?? null; },
      async run() { return execute(sql, params, 'run'); },
      _exec() { return execute(sql, params, 'run'); },
    };
    return statement;
  };

  return {
    sqlite,
    log,
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement._exec());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
