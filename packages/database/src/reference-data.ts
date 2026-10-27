import type { SqlExecutor } from "./client.js";

/**
 * Canonical reference data with stable identifiers (Requirement 18.5).
 *
 * Every row has a fixed UUID and a stable code. Both are permanent: a released identifier is never
 * renumbered, reused, or deleted, because Service Offerings, Equipment, bookings, and invoices
 * reference these rows by UUID and clients may store the code. Display names may change between
 * seed versions; the seed updates them in place. A retired concept is kept (not deleted) and a new
 * concept gets a new UUID and code, raising `REFERENCE_DATA_VERSION`.
 *
 * UUID scheme: `30000000-0000-4000-8000-<ordinal>` for Services and
 * `50000000-0000-4000-8000-<ordinal>` for Equipment Types, with a 12-digit ordinal.
 */
export const REFERENCE_DATA_VERSION = 1;

export interface ReferenceRow {
  readonly id: string;
  readonly stableCode: string;
  readonly displayName: string;
  /** Seed version that introduced the row. */
  readonly sinceVersion: number;
}

const row = (id: string, stableCode: string, displayName: string, sinceVersion = 1): ReferenceRow =>
  Object.freeze({ id, stableCode, displayName, sinceVersion });

export const canonicalServices: readonly ReferenceRow[] = Object.freeze([
  row("30000000-0000-4000-8000-000000000001", "PLOUGHING", "Ploughing"),
  row("30000000-0000-4000-8000-000000000002", "ROTAVATION", "Rotavator tilling"),
  row("30000000-0000-4000-8000-000000000003", "SOWING", "Sowing"),
  row("30000000-0000-4000-8000-000000000004", "HARVESTING", "Harvesting"),
  row("30000000-0000-4000-8000-000000000005", "HAULAGE", "Transport and haulage"),
  row("30000000-0000-4000-8000-000000000006", "LAND_LEVELLING", "Land levelling"),
]);

export const canonicalEquipmentTypes: readonly ReferenceRow[] = Object.freeze([
  row("50000000-0000-4000-8000-000000000001", "CULTIVATOR", "Cultivator"),
  row("50000000-0000-4000-8000-000000000002", "ROTAVATOR", "Rotavator"),
  row("50000000-0000-4000-8000-000000000003", "SEED_DRILL", "Seed drill"),
  row("50000000-0000-4000-8000-000000000004", "HARVESTER", "Harvester"),
  row("50000000-0000-4000-8000-000000000005", "TROLLEY", "Trolley"),
  row("50000000-0000-4000-8000-000000000006", "LAND_LEVELLER", "Land leveller"),
]);

/** Raised when the database already holds a stable code under a different UUID, or the reverse. */
export class ReferenceDataDriftError extends Error {
  readonly code = "REFERENCE_DATA_DRIFT";

  constructor(
    readonly table: "services" | "equipment_types",
    readonly stableCode: string,
    readonly expectedId: string,
    readonly actualId: string,
  ) {
    super(`${table} row ${stableCode} has id ${actualId}; the canonical id is ${expectedId}`);
    this.name = "ReferenceDataDriftError";
  }
}

export interface ReferenceSeedResult {
  readonly version: number;
  readonly inserted: number;
  readonly renamed: number;
  readonly unchanged: number;
}

interface ExistingRow extends Record<string, unknown> {
  readonly id: string;
  readonly stable_code: string;
  readonly display_name: string;
}

const seedTable = async (
  executor: SqlExecutor,
  table: "services" | "equipment_types",
  rows: readonly ReferenceRow[],
): Promise<{ inserted: number; renamed: number; unchanged: number }> => {
  const existing = await executor.query<ExistingRow>(
    `SELECT id::text AS id, stable_code, display_name FROM public.${table}
     WHERE id = ANY($1::uuid[]) OR stable_code = ANY($2::text[])`,
    [rows.map(({ id }) => id), rows.map(({ stableCode }) => stableCode)],
  );
  for (const current of existing.rows) {
    const byId = rows.find(({ id }) => id === current.id);
    const byCode = rows.find(({ stableCode }) => stableCode === current.stable_code);
    if (byCode !== undefined && byCode.id !== current.id) {
      throw new ReferenceDataDriftError(table, current.stable_code, byCode.id, current.id);
    }
    if (byId !== undefined && byId.stableCode !== current.stable_code) {
      throw new ReferenceDataDriftError(table, byId.stableCode, byId.id, `${current.id} (code ${current.stable_code})`);
    }
  }
  let inserted = 0;
  let renamed = 0;
  let unchanged = 0;
  for (const reference of rows) {
    const current = existing.rows.find(({ id }) => id === reference.id);
    if (current === undefined) {
      const result = await executor.query(
        `INSERT INTO public.${table} (id, stable_code, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [reference.id, reference.stableCode, reference.displayName],
      );
      inserted += result.rowCount;
    } else if (current.display_name !== reference.displayName) {
      await executor.query(
        `UPDATE public.${table} SET display_name = $2 WHERE id = $1 AND stable_code = $3`,
        [reference.id, reference.displayName, reference.stableCode],
      );
      renamed += 1;
    } else {
      unchanged += 1;
    }
  }
  return { inserted, renamed, unchanged };
};

/**
 * Idempotently writes the canonical Services and Equipment Types. Re-running it never changes an
 * identifier; it inserts missing rows, updates changed display names, and refuses identity drift.
 * Run it inside one transaction so a drift error leaves no partial seed.
 */
export async function seedReferenceData(executor: SqlExecutor): Promise<ReferenceSeedResult> {
  const services = await seedTable(executor, "services", canonicalServices);
  const equipmentTypes = await seedTable(executor, "equipment_types", canonicalEquipmentTypes);
  return Object.freeze({
    version: REFERENCE_DATA_VERSION,
    inserted: services.inserted + equipmentTypes.inserted,
    renamed: services.renamed + equipmentTypes.renamed,
    unchanged: services.unchanged + equipmentTypes.unchanged,
  });
}
