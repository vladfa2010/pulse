declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }
  interface Database {
    run(sql: string, params?: any[]): void;
    exec(sql: string): Array<{ columns: string[]; values: any[][] }>;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }
  interface Statement {
    bind(values?: any[]): boolean;
    step(): boolean;
    get(): any[] | null;
    getAsObject(): any;
    run(values?: any[]): void;
    all(values?: any[]): any[];
    free(): boolean;
  }
  function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
  export default initSqlJs;
}
