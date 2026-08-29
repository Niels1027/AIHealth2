// Node 22 内置 node:sqlite 的最小类型声明（@types/node@20 尚未收录）
declare module "node:sqlite" {
  type SQLInput = string | number | bigint | null | Uint8Array;
  type SQLOutput = string | number | bigint | null | Uint8Array;

  export interface StatementSync {
    run(...params: SQLInput[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SQLInput[]): Record<string, SQLOutput> | undefined;
    all(...params: SQLInput[]): Record<string, SQLOutput>[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
