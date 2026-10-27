import { describe, expect, it } from "vitest";

import { REFERENCE_DATA_VERSION, canonicalEquipmentTypes, canonicalServices } from "./reference-data.js";

/**
 * Released identifiers, pinned. A row may be added (with a new UUID and a higher sinceVersion),
 * but an entry here may never change or disappear: bookings and invoices reference these UUIDs.
 */
const RELEASED_SERVICES: ReadonlyArray<readonly [string, string]> = [
  ["30000000-0000-4000-8000-000000000001", "PLOUGHING"],
  ["30000000-0000-4000-8000-000000000002", "ROTAVATION"],
  ["30000000-0000-4000-8000-000000000003", "SOWING"],
  ["30000000-0000-4000-8000-000000000004", "HARVESTING"],
  ["30000000-0000-4000-8000-000000000005", "HAULAGE"],
  ["30000000-0000-4000-8000-000000000006", "LAND_LEVELLING"],
];
const RELEASED_EQUIPMENT_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["50000000-0000-4000-8000-000000000001", "CULTIVATOR"],
  ["50000000-0000-4000-8000-000000000002", "ROTAVATOR"],
  ["50000000-0000-4000-8000-000000000003", "SEED_DRILL"],
  ["50000000-0000-4000-8000-000000000004", "HARVESTER"],
  ["50000000-0000-4000-8000-000000000005", "TROLLEY"],
  ["50000000-0000-4000-8000-000000000006", "LAND_LEVELLER"],
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

/** Validates: Requirements 18.5 */
describe("canonical reference data", () => {
  for (const [label, rows, released, prefix] of [
    ["Services", canonicalServices, RELEASED_SERVICES, "30000000-0000-4000-8000-"],
    ["Equipment Types", canonicalEquipmentTypes, RELEASED_EQUIPMENT_TYPES, "50000000-0000-4000-8000-"],
  ] as const) {
    it(`keeps every released ${label} UUID and stable code unchanged`, () => {
      for (const [id, code] of released) {
        expect(rows.find((row) => row.id === id)?.stableCode, `${label} ${id}`).toBe(code);
      }
    });

    it(`gives ${label} unique, well-formed, versioned identifiers`, () => {
      expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
      expect(new Set(rows.map(({ stableCode }) => stableCode)).size).toBe(rows.length);
      for (const row of rows) {
        expect(row.id).toMatch(UUID);
        expect(row.id.startsWith(prefix)).toBe(true);
        expect(row.stableCode).toMatch(CODE);
        expect(row.displayName.trim().length).toBeGreaterThan(0);
        expect(row.sinceVersion).toBeGreaterThanOrEqual(1);
        expect(row.sinceVersion).toBeLessThanOrEqual(REFERENCE_DATA_VERSION);
        expect(Object.isFrozen(row)).toBe(true);
      }
      expect(Object.isFrozen(rows)).toBe(true);
    });
  }
});
