import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Env } from "../../src/types";

export function createMockD1(sqliteDb?: Database.Database): any {
  const db = sqliteDb || new Database(":memory:");
  db.pragma("foreign_keys = ON");

  function normalizeBindings(query: string, boundParams: any[]) {
    const numbered: any[] = [];
    const normalizedQuery = query.replace(/\?(\d+)/g, (_placeholder, rawIndex: string) => {
      const index = Number(rawIndex) - 1;
      if (index < 0 || index >= boundParams.length) {
        throw new Error(`Missing D1 binding ?${rawIndex}`);
      }
      numbered.push(boundParams[index]);
      return "?";
    });
    return numbered.length > 0
      ? { query: normalizedQuery, params: numbered }
      : { query, params: boundParams };
  }

  function createStatement(query: string, boundParams: any[] = []) {
    const prepared = () => {
      const normalized = normalizeBindings(query, boundParams);
      return { stmt: db.prepare(normalized.query), params: normalized.params };
    };
    const statement = {
      bind(...params: any[]) {
        return createStatement(query, params);
      },
      async all() {
        const { stmt, params } = prepared();
        const results = stmt.all(...params);
        return {
          results,
          success: true,
          meta: {
            duration: 0,
            changes: 0,
            last_row_id: 0,
            served_by: "better-sqlite3-mock",
          },
        };
      },
      async get() {
        const { stmt, params } = prepared();
        const result = stmt.get(...params);
        return result ?? undefined;
      },
      async run() {
        return statement._runSync();
      },
      _runSync() {
        const { stmt, params } = prepared();
        const info = stmt.run(...params);
        return {
          success: true,
          meta: {
            duration: 0,
            changes: info.changes,
            last_row_id: Number(info.lastInsertRowid),
            served_by: "better-sqlite3-mock",
          },
        };
      },
      async raw() {
        const { stmt, params } = prepared();
        return stmt.raw().all(...params);
      },
    };
    return statement;
  }

  return {
    prepare(query: string) {
      return createStatement(query);
    },
    async batch(statements: any[]) {
      return db.transaction(() =>
        statements.map((statement) => {
          if (typeof statement?._runSync !== "function") {
            throw new Error("Mock D1 batch only accepts prepared statements");
          }
          return statement._runSync();
        })
      )();
    },
    async exec(query: string) {
      db.exec(query);
      return { count: 1, duration: 0 };
    },
    _rawDb: db,
  };
}

export function applyMigrations(sqliteDb: Database.Database): void {
  const drizzleDir = path.resolve(__dirname, "../../drizzle");
  const sqlFiles = fs
    .readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of sqlFiles) {
    const rawSql = fs.readFileSync(path.join(drizzleDir, file), "utf-8");
    const statements = rawSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      sqliteDb.exec(statement);
    }
  }
}

export interface TestEnvContext {
  env: Env;
  sqliteDb: Database.Database;
  d1: any;
  sentQueueMessages: any[];
}

export function createTestEnv(overrides?: Partial<Env>): TestEnvContext {
  const sqliteDb = new Database(":memory:");
  applyMigrations(sqliteDb);
  const d1 = createMockD1(sqliteDb);

  const sentQueueMessages: any[] = [];

  const kvValues = new Map<string, string>();
  const mockKv: any = {
    async get(key: string) { return kvValues.get(key) ?? null; },
    async put(key: string, value: string) { kvValues.set(key, value); },
    async delete(key: string) { kvValues.delete(key); },
  };

  const defaultMasterKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const env: Env = {
    DB: d1,
    KEYS_KV: mockKv,
    STORAGE_ENCRYPTION_KEY: defaultMasterKey,
    STORAGE_ENCRYPTION_KEY_ID: "test-primary",
    INITIAL_SETUP_TOKEN: "test-setup-token-super-secure-32chars",
    ENVIRONMENT: "test",
    APP_VERSION: "1.0.0",
    ...overrides,
  };

  return { env, sqliteDb, d1, sentQueueMessages };
}
