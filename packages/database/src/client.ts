export interface SqlQueryResult<Row extends object = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

export interface SqlConnection extends SqlExecutor {
  release(): void;
}

export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlConnection>;
  end?(): Promise<void>;
}
