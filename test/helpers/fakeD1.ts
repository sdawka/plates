// In-memory D1 stand-in backed by node:sqlite. Implements the subset of the D1 API the repo uses.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

type Params = unknown[];

class FakeStatement {
  constructor(readonly sqlite: DatabaseSync, readonly sql: string, readonly params: Params = []) {}

  bind(...params: Params): FakeStatement {
    return new FakeStatement(this.sqlite, this.sql, params.map((p) => (p === undefined ? null : p)));
  }

  /** Synchronous core, shared by run() and db.batch(). */
  exec(): { results: Record<string, unknown>[]; meta: { changes: number } } {
    const stmt = this.sqlite.prepare(this.sql);
    if (/^\s*(select|with)/i.test(this.sql)) {
      return { results: stmt.all(...this.params), meta: { changes: 0 } };
    }
    const r = stmt.run(...this.params);
    return { results: [], meta: { changes: Number(r.changes) } };
  }

  async first<T>(col?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const r = this.exec();
    return { results: r.results.map((x) => ({ ...x })) as T[], success: true, meta: r.meta };
  }

  async run() {
    const r = this.exec();
    return { results: r.results, success: true, meta: r.meta };
  }
}

export class FakeD1 {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    const dir = new URL("../../migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
    }
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.sqlite, sql);
  }

  /** Runs all statements in one transaction; rolls back everything if one throws (like D1). */
  async batch(stmts: FakeStatement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => ({ ...s.exec(), success: true }));
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }

  all(sql: string, ...params: Params): Record<string, unknown>[] {
    return this.sqlite.prepare(sql).all(...params);
  }
}

export function makeDb(): FakeD1 {
  return new FakeD1();
}

/** Cast for passing to code that expects the Workers type. */
export const asD1 = (db: { prepare: unknown }) => db as unknown as D1Database;
