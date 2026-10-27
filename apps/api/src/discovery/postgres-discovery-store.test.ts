import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import { describe, expect, it } from "vitest";

import type { NormalizedDiscoveryQuery } from "./discovery.contracts.js";
import { PostgresDiscoveryStore } from "./postgres-discovery-store.js";

class RecordingPool implements SqlPool {
  readonly calls: { text: string; values: readonly unknown[] }[] = [];

  async query<Row extends object>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    const rows = [{
      tractor_id: "10000000-0000-0000-0000-000000000001",
      brand: "Sonalika",
      model: "DI 35",
      state: "Karnataka",
      district: "Mysuru",
      owner_display_name: null,
      photo_alt_text: "Blue tractor",
      service_offering_id: "20000000-0000-0000-0000-000000000001",
      service_id: "30000000-0000-0000-0000-000000000001",
      service_name: "Tilling",
      equipment_id: "40000000-0000-0000-0000-000000000001",
      equipment_type_id: "50000000-0000-0000-0000-000000000001",
      equipment_name: "Cultivator",
      pricing_rules: [{
        id: "60000000-0000-0000-0000-000000000001",
        method: "HOURLY",
        ratePaise: "90000",
        currency: "INR",
        roundingPolicy: "PROPORTIONAL_MINUTE",
      }],
      availability_rank: 0,
      distance_meters: "2450.25",
    }];
    return { rows: rows as readonly Row[], rowCount: rows.length };
  }

  async connect(): Promise<SqlConnection> {
    throw new Error("not needed for a read-only discovery query");
  }
}

const query: NormalizedDiscoveryQuery = {
  serviceLocation: {
    state: "Karnataka",
    district: "Mysuru",
    mandalOrTaluk: "Nanjangud",
    village: "Farm",
    source: "MANUAL_ADDRESS",
    latitude: 12.1198,
    longitude: 76.6801,
    capturedAt: new Date("2025-03-01T09:00:00.000Z"),
    collectionPurpose: "SERVICE_LOCATION",
  },
  serviceId: "30000000-0000-0000-0000-000000000001",
  equipmentTypeId: "50000000-0000-0000-0000-000000000001",
  pricingMethod: "HOURLY",
  requestedInterval: {
    start: new Date("2025-03-02T04:00:00.000Z"),
    end: new Date("2025-03-02T08:00:00.000Z"),
  },
  radiusKilometers: 25,
  pageSize: 20,
  evaluatedAt: new Date("2025-03-01T10:00:00.000Z"),
  staleBefore: new Date("2025-02-28T10:00:00.000Z"),
  cursor: {
    availabilityRank: 0,
    distanceMeters: 1_500,
    tractorId: "10000000-0000-0000-0000-000000000000",
  },
};

/** Validates: Requirements 3.3, 3.4, 7.4, 7.5, 7.6, 7.8, 18.3 */
describe("PostgresDiscoveryStore", () => {
  it("executes one spatially bounded, keyset-paginated eligibility query and maps an allowlisted card source", async () => {
    const pool = new RecordingPool();
    const store = new PostgresDiscoveryStore(pool);

    await expect(store.search(query)).resolves.toEqual([{
      tractorId: "10000000-0000-0000-0000-000000000001",
      brand: "Sonalika",
      model: "DI 35",
      state: "Karnataka",
      district: "Mysuru",
      photoAltText: "Blue tractor",
      serviceOfferingId: "20000000-0000-0000-0000-000000000001",
      serviceId: "30000000-0000-0000-0000-000000000001",
      serviceName: "Tilling",
      equipmentId: "40000000-0000-0000-0000-000000000001",
      equipmentTypeId: "50000000-0000-0000-0000-000000000001",
      equipmentName: "Cultivator",
      pricingRules: [{
        id: "60000000-0000-0000-0000-000000000001",
        method: "HOURLY",
        ratePaise: 90_000,
        currency: "INR",
        roundingPolicy: "PROPORTIONAL_MINUTE",
      }],
      availabilityRank: 0,
      distanceMeters: 2450.25,
    }]);

    const call = pool.calls[0]!;
    expect(call.text).toMatch(/ST_DWithin\(l\.coordinates, origin\.point, \$3/iu);
    expect(call.text).toMatch(/t\.operational_status = 'ONLINE'/u);
    expect(call.text).toMatch(/ta\.operational_status = 'ONLINE'/u);
    expect(call.text).toMatch(/t\.eligibility_status = 'ELIGIBLE'/u);
    expect(call.text).toMatch(/t\.location_updated_at >= \$8[\s\S]*t\.location_updated_at <= \$10/iu);
    expect(call.text).toMatch(/so\.enabled = true/iu);
    expect(call.text).toMatch(/e\.availability_status = 'AVAILABLE'/u);
    expect(call.text).toMatch(/pr\.enabled = true/iu);
    expect(call.text).toMatch(/blocking\.requested_start_at < \$7[\s\S]*\$6 < blocking\.requested_end_at/iu);
    expect(call.text).toMatch(/ORDER BY availability_rank ASC, distance_meters ASC, tractor_id ASC[\s\S]*LIMIT \$14/iu);
    // Keyset pagination only: the single OFFSET 0 is a planner fence on the Tractor lookup.
    expect(call.text.match(/\bOFFSET\s+\S+/gu)).toEqual(["OFFSET 0"]);
    expect(call.text).toMatch(/WHERE t\.current_location_id = l\.id[\s\S]*OFFSET 0\s*\) t ON true/u);
    expect(call.text).not.toMatch(/phone_lookup_hash|registration_number_ciphertext|object_key_ciphertext/iu);
    expect(call.values).toEqual([
      76.6801,
      12.1198,
      25_000,
      "30000000-0000-0000-0000-000000000001",
      "50000000-0000-0000-0000-000000000001",
      "2025-03-02T04:00:00.000Z",
      "2025-03-02T08:00:00.000Z",
      "2025-02-28T10:00:00.000Z",
      "HOURLY",
      "2025-03-01T10:00:00.000Z",
      0,
      1_500,
      "10000000-0000-0000-0000-000000000000",
      21,
    ]);
  });
});
