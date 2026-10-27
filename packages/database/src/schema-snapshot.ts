import type { SqlExecutor } from "./client.js";

/**
 * Catalog snapshot of the application schema (`public`, excluding objects owned by extensions such
 * as PostGIS). Used to prove migrations are additive, that down→up round-trips restore the exact
 * schema, and that a restored backup matches its source. Read-only: it queries only the catalog.
 */
export interface SchemaSnapshot {
  readonly tables: readonly string[];
  /** `table.column` → `type|NOT NULL|default` */
  readonly columns: Readonly<Record<string, ColumnShape>>;
  /** enum type → labels in sort order */
  readonly enums: Readonly<Record<string, readonly string[]>>;
  /** index name → { table, definition } */
  readonly indexes: Readonly<Record<string, Readonly<{ table: string; definition: string; unique: boolean; backsConstraint: boolean; columns: readonly string[] | null }>>>;
  /** `table.constraint` → { type, definition, validated } */
  readonly constraints: Readonly<Record<string, Readonly<{ table: string; type: string; definition: string; columns: readonly string[] }>>>;
  /** `table.trigger` → definition */
  readonly triggers: Readonly<Record<string, string>>;
  /** `name(args)` → md5 of the full definition */
  readonly functions: Readonly<Record<string, string>>;
  /** Installed extensions (informational; rollbacks intentionally leave shared extensions). */
  readonly extensions: readonly string[];
}

export interface ColumnShape {
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultExpression: string | null;
}

const NOT_EXTENSION_MEMBER = (classTable: string, alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${classTable}'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`;

/** Tables that belong to tooling rather than the application schema. */
const TOOLING_TABLES = new Set(["kisantractor_schema_migrations"]);

export async function captureSchemaSnapshot(executor: SqlExecutor): Promise<SchemaSnapshot> {
  const tables = await executor.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND ${NOT_EXTENSION_MEMBER("pg_class", "c")}
     ORDER BY 1`,
  );
  const tableNames = tables.rows.map(({ name }) => name).filter((name) => !TOOLING_TABLES.has(name));
  const tableSet = new Set(tableNames);

  const columns = await executor.query<{ table_name: string; column_name: string; type: string; not_null: boolean; default_expression: string | null }>(
    `SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(ad.adbin, ad.adrelid) AS default_expression
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY 1, 2`,
  );
  const enums = await executor.query<{ name: string; labels: string[] }>(
    `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
     FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = 'public' AND ${NOT_EXTENSION_MEMBER("pg_type", "t")}
     GROUP BY t.typname ORDER BY 1`,
  );
  const indexes = await executor.query<{ name: string; table_name: string; definition: string; is_unique: boolean; backs_constraint: boolean; columns: string[] | null }>(
    `SELECT ic.relname AS name, tc.relname AS table_name, pg_get_indexdef(i.indexrelid) AS definition,
            i.indisunique AS is_unique,
            CASE WHEN i.indexprs IS NULL AND i.indpred IS NULL THEN
              ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) AS key(attnum)
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum ORDER BY 1)
            END AS columns,
            EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid) AS backs_constraint
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_class tc ON tc.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = tc.relnamespace
     WHERE n.nspname = 'public' AND ${NOT_EXTENSION_MEMBER("pg_class", "tc")}
     ORDER BY 1`,
  );
  const constraints = await executor.query<{ table_name: string; name: string; type: string; definition: string; columns: string[] }>(
    `SELECT c.relname AS table_name, k.conname AS name, k.contype::text AS type, pg_get_constraintdef(k.oid) AS definition,
            ARRAY(SELECT a.attname::text FROM unnest(coalesce(k.conkey, '{}'::int2[])) AS key(attnum)
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = key.attnum ORDER BY 1) AS columns
     FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND ${NOT_EXTENSION_MEMBER("pg_class", "c")}
     ORDER BY 1, 2`,
  );
  const triggers = await executor.query<{ table_name: string; name: string; definition: string }>(
    `SELECT c.relname AS table_name, t.tgname AS name, pg_get_triggerdef(t.oid) AS definition
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY 1, 2`,
  );
  const functions = await executor.query<{ signature: string; digest: string }>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
            md5(pg_get_functiondef(p.oid)) AS digest
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f' AND ${NOT_EXTENSION_MEMBER("pg_proc", "p")}
     ORDER BY 1`,
  );
  const extensions = await executor.query<{ name: string }>("SELECT extname AS name FROM pg_extension ORDER BY 1");

  return Object.freeze({
    tables: Object.freeze(tableNames),
    columns: Object.freeze(Object.fromEntries(columns.rows
      .filter((column) => tableSet.has(column.table_name))
      .map((column) => [`${column.table_name}.${column.column_name}`, Object.freeze({
        type: column.type, notNull: column.not_null, defaultExpression: column.default_expression,
      })]))),
    enums: Object.freeze(Object.fromEntries(enums.rows.map(({ name, labels }) => [name, Object.freeze([...labels])]))),
    indexes: Object.freeze(Object.fromEntries(indexes.rows
      .filter((index) => tableSet.has(index.table_name))
      .map((index) => [index.name, Object.freeze({
        table: index.table_name, definition: index.definition, unique: index.is_unique, backsConstraint: index.backs_constraint,
        columns: index.columns === null ? null : Object.freeze([...index.columns]),
      })]))),
    constraints: Object.freeze(Object.fromEntries(constraints.rows
      .filter((constraint) => tableSet.has(constraint.table_name))
      .map((constraint) => [`${constraint.table_name}.${constraint.name}`, Object.freeze({
        table: constraint.table_name, type: constraint.type, definition: constraint.definition,
        columns: Object.freeze([...constraint.columns]),
      })]))),
    triggers: Object.freeze(Object.fromEntries(triggers.rows
      .filter((trigger) => tableSet.has(trigger.table_name))
      .map(({ table_name, name, definition }) => [`${table_name}.${name}`, definition]))),
    functions: Object.freeze(Object.fromEntries(functions.rows.map(({ signature, digest }) => [signature, digest]))),
    extensions: Object.freeze(extensions.rows.map(({ name }) => name)),
  });
}

/** Snapshot without the informational extension list, for equality checks. */
export function comparableSchema(snapshot: SchemaSnapshot): Omit<SchemaSnapshot, "extensions"> {
  const { extensions: _extensions, ...rest } = snapshot;
  return rest;
}

/**
 * A change between two consecutive schema versions that is not purely additive. Destructive kinds
 * (drops, renames, type changes) and narrowing kinds (new NOT NULL or new constraints on a table
 * that already existed, which existing rows might violate) are both reported.
 */
export interface AdditivityFinding {
  readonly kind:
    | "TABLE_DROPPED"
    | "COLUMN_DROPPED"
    | "COLUMN_TYPE_CHANGED"
    | "COLUMN_SET_NOT_NULL"
    | "NOT_NULL_COLUMN_WITHOUT_DEFAULT_ADDED"
    | "ENUM_DROPPED"
    | "ENUM_VALUE_REMOVED_OR_REORDERED"
    | "INDEX_DROPPED"
    | "INDEX_CHANGED"
    | "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE"
    | "CONSTRAINT_DROPPED"
    | "CONSTRAINT_CHANGED"
    | "CONSTRAINT_ADDED_TO_EXISTING_TABLE"
    | "TRIGGER_DROPPED"
    | "TRIGGER_CHANGED"
    | "FUNCTION_DROPPED"
    | "FUNCTION_CHANGED";
  readonly object: string;
}

export const findingKey = ({ kind, object }: AdditivityFinding): string => `${kind}:${object}`;

export function additivityFindings(before: SchemaSnapshot, after: SchemaSnapshot): AdditivityFinding[] {
  const findings: AdditivityFinding[] = [];
  const add = (kind: AdditivityFinding["kind"], object: string) => findings.push({ kind, object });
  const existingTables = new Set(before.tables);
  const afterTables = new Set(after.tables);

  for (const table of before.tables) if (!afterTables.has(table)) add("TABLE_DROPPED", table);
  for (const [name, shape] of Object.entries(before.columns)) {
    const next = after.columns[name];
    if (next === undefined) {
      add("COLUMN_DROPPED", name);
      continue;
    }
    if (next.type !== shape.type) add("COLUMN_TYPE_CHANGED", name);
    if (!shape.notNull && next.notNull) add("COLUMN_SET_NOT_NULL", name);
  }
  for (const [name, shape] of Object.entries(after.columns)) {
    const table = name.slice(0, name.indexOf("."));
    if (before.columns[name] === undefined && existingTables.has(table) && shape.notNull && shape.defaultExpression === null) {
      add("NOT_NULL_COLUMN_WITHOUT_DEFAULT_ADDED", name);
    }
  }
  for (const [name, labels] of Object.entries(before.enums)) {
    const next = after.enums[name];
    if (next === undefined) {
      add("ENUM_DROPPED", name);
      continue;
    }
    const positions = labels.map((label) => next.indexOf(label));
    if (positions.some((position, index) => position === -1 || (index > 0 && position < positions[index - 1]!))) {
      add("ENUM_VALUE_REMOVED_OR_REORDERED", name);
    }
  }
  for (const [name, index] of Object.entries(before.indexes)) {
    const next = after.indexes[name];
    if (next === undefined) {
      if (afterTables.has(index.table)) add("INDEX_DROPPED", name);
    } else if (next.definition !== index.definition) add("INDEX_CHANGED", name);
  }
  // A constraint or unique index that reads only columns added in this step cannot reject an
  // existing row: those columns are NULL or defaulted on every row that predates the migration.
  const onlyNewColumns = (table: string, columns: readonly string[] | null): boolean =>
    columns !== null && columns.length > 0 && columns.every((column) => before.columns[`${table}.${column}`] === undefined);
  for (const [name, index] of Object.entries(after.indexes)) {
    if (before.indexes[name] === undefined && existingTables.has(index.table) && index.unique && !index.backsConstraint
      && !onlyNewColumns(index.table, index.columns)) {
      add("UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE", name);
    }
  }
  for (const [name, constraint] of Object.entries(before.constraints)) {
    const next = after.constraints[name];
    if (next === undefined) {
      if (afterTables.has(constraint.table)) add("CONSTRAINT_DROPPED", name);
    } else if (next.definition !== constraint.definition) add("CONSTRAINT_CHANGED", name);
  }
  for (const [name, constraint] of Object.entries(after.constraints)) {
    // NOT NULL constraints (contype 'n', PostgreSQL 18+) are covered by the column checks.
    if (before.constraints[name] === undefined && existingTables.has(constraint.table) && constraint.type !== "n"
      && !onlyNewColumns(constraint.table, constraint.columns)) {
      add("CONSTRAINT_ADDED_TO_EXISTING_TABLE", name);
    }
  }
  for (const [name, definition] of Object.entries(before.triggers)) {
    const next = after.triggers[name];
    const table = name.slice(0, name.indexOf("."));
    if (next === undefined) {
      if (afterTables.has(table)) add("TRIGGER_DROPPED", name);
    } else if (next !== definition) add("TRIGGER_CHANGED", name);
  }
  for (const [name, digest] of Object.entries(before.functions)) {
    const next = after.functions[name];
    if (next === undefined) add("FUNCTION_DROPPED", name);
    else if (next !== digest) add("FUNCTION_CHANGED", name);
  }
  return findings;
}

/** Row count and order-independent checksum of one table over the given columns. */
export interface TableChecksum {
  readonly rows: number;
  readonly checksum: string;
}

const quoteIdentifier = (identifier: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new TypeError(`Unsafe identifier ${identifier}`);
  return `"${identifier}"`;
};

/**
 * Checksums every listed table over its listed columns (default: all current columns), so data
 * written at one schema version can be compared after later migrations add columns.
 */
export async function tableChecksums(
  executor: SqlExecutor,
  columnsByTable: Readonly<Record<string, readonly string[]>>,
): Promise<Record<string, TableChecksum>> {
  const result: Record<string, TableChecksum> = {};
  for (const [table, columns] of Object.entries(columnsByTable)) {
    const projection = columns.map(quoteIdentifier).join(", ");
    const rows = await executor.query<{ row_count: string; checksum: string | null }>(
      `SELECT count(*)::text AS row_count,
              md5(coalesce(string_agg(row_text, E'\\n' ORDER BY row_text), '')) AS checksum
       FROM (SELECT ROW(${projection})::text AS row_text FROM public.${quoteIdentifier(table)}) AS t`,
    );
    result[table] = Object.freeze({ rows: Number(rows.rows[0]?.row_count ?? 0), checksum: rows.rows[0]?.checksum ?? "" });
  }
  return result;
}

/** Current column lists per table, from a snapshot. */
export function columnsByTable(snapshot: SchemaSnapshot): Record<string, string[]> {
  const columns: Record<string, string[]> = {};
  for (const name of Object.keys(snapshot.columns).sort()) {
    const [table, column] = name.split(".") as [string, string];
    (columns[table] ??= []).push(column);
  }
  return columns;
}
