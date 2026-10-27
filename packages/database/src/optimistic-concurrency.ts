import type { SqlExecutor } from "./client.js";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

const quoteIdentifier = (identifier: string): string => {
  if (!IDENTIFIER.test(identifier)) {
    throw new TypeError(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

export class OptimisticConcurrencyError extends Error {
  readonly code = "OPTIMISTIC_CONCURRENCY_CONFLICT";

  constructor(
    readonly entityType: string,
    readonly entityId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `${entityType} ${entityId} no longer has expected version ${expectedVersion}`,
    );
    this.name = "OptimisticConcurrencyError";
  }
}

export interface OptimisticUpdateInput {
  readonly table: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly expectedVersion: number;
  readonly changes: Readonly<Record<string, unknown>>;
  readonly idColumn?: string;
  readonly versionColumn?: string;
  readonly updatedAtColumn?: string;
}

export async function updateWithOptimisticLock<Row extends object>(
  executor: SqlExecutor,
  input: OptimisticUpdateInput,
): Promise<Row> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new TypeError("expectedVersion must be a positive safe integer");
  }

  const table = quoteIdentifier(input.table);
  const idColumn = quoteIdentifier(input.idColumn ?? "id");
  const versionColumnName = input.versionColumn ?? "version";
  const versionColumn = quoteIdentifier(versionColumnName);
  const updatedAtColumn =
    input.updatedAtColumn === undefined
      ? undefined
      : quoteIdentifier(input.updatedAtColumn);
  const entries = Object.entries(input.changes);

  if (entries.length === 0) {
    throw new TypeError("At least one field must be changed");
  }

  const protectedColumns = new Set([
    input.idColumn ?? "id",
    versionColumnName,
    ...(input.updatedAtColumn === undefined ? [] : [input.updatedAtColumn]),
  ]);
  const values: unknown[] = [];
  const assignments = entries.map(([column, value]) => {
    if (protectedColumns.has(column)) {
      throw new TypeError(`Cannot directly change protected column: ${column}`);
    }
    if (value === undefined) {
      throw new TypeError(`Change value for ${column} must not be undefined`);
    }
    values.push(value);
    return `${quoteIdentifier(column)} = $${values.length}`;
  });

  assignments.push(`${versionColumn} = ${versionColumn} + 1`);
  if (updatedAtColumn !== undefined) {
    assignments.push(`${updatedAtColumn} = CURRENT_TIMESTAMP`);
  }

  values.push(input.entityId, input.expectedVersion);
  const result = await executor.query<Row>(
    `UPDATE public.${table} SET ${assignments.join(", ")} WHERE ${idColumn} = $${values.length - 1} AND ${versionColumn} = $${values.length} RETURNING *`,
    values,
  );
  const row = result.rows[0];

  if (result.rowCount !== 1 || row === undefined) {
    throw new OptimisticConcurrencyError(
      input.entityType,
      input.entityId,
      input.expectedVersion,
    );
  }

  return row;
}
