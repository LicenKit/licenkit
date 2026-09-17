import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Env } from "../../src/types";

export function createMockD1(sqliteDb?: Database.Database): any {
  const db = sqliteDb || new Database(":memory:");
  db.pragma("foreign_keys = ON");

  function createStatement(query: string, boundParams: any[] = []) {
    return {
      bind(...params: any[]) {
        return createStatement(query, params);
      },
      async all() {
        const stmt = db.prepare(query);
        const results = stmt.all(...boundParams);
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
        const stmt = db.prepare(query);
        const result = stmt.get(...boundParams);
        return result ?? undefined;
      },
      async run() {
        const stmt = db.prepare(query);
        const info = stmt.run(...boundParams);
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
        const stmt = db.prepare(query);
        return stmt.raw().all(...boundParams);
      },
    };
  }

  return {
    prepare(query: string) {
      return createStatement(query);
    },
    async batch(statements: any[]) {
      const results: any[] = [];
      const tx = db.transaction(() => {
        for (const s of statements) {
          results.push(s.run ? s.run() : s);
        }
      });
      tx();
      return results;
    },
    async exec(query: string) {
      db.exec(query);
      return { count: 1, duration: 0 };
    },
    _rawDb: db,
  };
}

export function applyMigrations(sqliteDb: Database.Database): void {
  const sqlPath = path.resolve(__dirname, "../../drizzle/0000_sloppy_green_goblin.sql");
  const rawSql = fs.readFileSync(sqlPath, "utf-8");
  const statements = rawSql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    sqliteDb.exec(statement);
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
  const mockQueue: any = {
    async send(message: any) {
      sentQueueMessages.push(message);
    },
    async sendBatch(messages: any[]) {
      sentQueueMessages.push(...messages);
    },
  };

  const mockKv: any = {
    async get() { return null; },
    async put() {},
    async delete() {},
  };

  const defaultMasterKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const defaultJwtSecret = "test-jwt-secret-key-super-secure-32chars";

  const env: Env = {
    DB: d1,
    KEYS_KV: mockKv,
    EVENT_QUEUE: mockQueue,
    STORAGE_ENCRYPTION_KEY: defaultMasterKey,
    JWT_SECRET: defaultJwtSecret,
    ENVIRONMENT: "test",
    APP_VERSION: "1.0.0",
    ...overrides,
  };

  return { env, sqliteDb, d1, sentQueueMessages };
}
