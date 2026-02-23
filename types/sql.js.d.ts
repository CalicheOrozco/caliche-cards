declare module "sql.js" {
  type SqlJsModule = {
    Database: new (data?: Uint8Array) => {
      exec: (
        sql: string,
        params?: unknown[]
      ) => Array<{ columns: string[]; values: unknown[][] }>;
      close: () => void;
    };
  };

  export default function initSqlJs(config: {
    locateFile: (file: string) => string;
    wasmBinary?: Uint8Array;
  }): Promise<SqlJsModule>;
}
