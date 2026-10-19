// Minimal typings: the project has no @types/node.
declare module "node:sqlite" {
  export class StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
interface ImportMeta {
  url: string;
}
