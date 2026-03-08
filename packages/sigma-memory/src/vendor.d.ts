/**
 * Type declarations for external dependencies.
 * Minimal declarations to avoid needing @types packages.
 */

declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: any[]): Database;
    exec(sql: string): Array<{ columns: string[]; values: any[][] }>;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  interface Statement {
    bind(params?: any[]): boolean;
    step(): boolean;
    get(): any[];
    getAsObject(): Record<string, any>;
    free(): void;
    run(params?: any[]): void;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | null) => Database;
  }

  export type { Database, Statement, SqlJsStatic };
  export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
}
