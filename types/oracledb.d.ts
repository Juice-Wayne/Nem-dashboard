declare module "oracledb" {
  export const OUT_FORMAT_OBJECT: number;

  export interface PoolAttributes {
    user?: string;
    password?: string;
    connectString?: string;
    poolMin?: number;
    poolMax?: number;
    poolIncrement?: number;
  }

  export interface ExecuteOptions {
    outFormat?: number;
  }

  export type BindParameters = unknown[] | Record<string, unknown>;

  export interface Result<T> {
    rows?: T[];
    metaData?: Array<{ name: string }>;
  }

  export interface Connection {
    execute<T>(
      sql: string,
      binds?: BindParameters,
      options?: ExecuteOptions,
    ): Promise<Result<T>>;
    close(): Promise<void>;
  }

  export interface Pool {
    getConnection(): Promise<Connection>;
    close(drainTime?: number): Promise<void>;
  }

  export function createPool(attrs: PoolAttributes): Promise<Pool>;

  const oracledb: {
    OUT_FORMAT_OBJECT: number;
    createPool: typeof createPool;
  };

  export default oracledb;
}
