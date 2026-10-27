import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import { describe, expect, it } from "vitest";

import { PostgresCatalogStore } from "./postgres-catalog-store.js";

class RecordingPool implements SqlPool {
  readonly calls: { text: string; values?: readonly unknown[] }[] = [];
  rows: readonly Record<string, unknown>[] = [];

  async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, ...(values === undefined ? {} : { values }) });
    return { rows: this.rows as readonly Row[], rowCount: this.rows.length };
  }

  async connect(): Promise<never> {
    throw new Error("not needed");
  }
}

const secrets = {
  fieldEncryptionKey: new Uint8Array(32).fill(5),
  lookupHashKey: new Uint8Array(32).fill(7),
};

const activeRow = {
  id: "pricing-v2",
  service_offering_id: "offering-1",
  method: "HOURLY",
  rate_paise: "90000",
  currency: "INR",
  rounding_policy: "ONE_HOUR_BLOCK",
  enabled: true,
  version: 2,
};

/** Validates: Requirements 6.4, 6.6, 6.7 */
describe("PostgresCatalogStore active Pricing Rules", () => {
  it("queries only enabled rules and offerings valid at the disclosure instant", async () => {
    const pool = new RecordingPool();
    pool.rows = [activeRow];
    const store = new PostgresCatalogStore(pool, secrets);
    const activeAt = new Date("2025-03-01T10:00:00.000Z");

    await expect(store.listActivePricingRules("offering-1", activeAt)).resolves.toEqual([{
      id: "pricing-v2",
      serviceOfferingId: "offering-1",
      method: "HOURLY",
      ratePaise: 90_000,
      currency: "INR",
      roundingPolicy: "ONE_HOUR_BLOCK",
      version: 2,
    }]);

    const call = pool.calls[0]!;
    expect(call.text).toMatch(/so\.enabled = true/iu);
    expect(call.text).toMatch(/pr\.enabled = true/iu);
    expect(call.text).toMatch(/pr\.valid_from <= \$2/iu);
    expect(call.text).toMatch(/pr\.valid_to IS NULL OR pr\.valid_to > \$2/iu);
    expect(call.values).toEqual(["offering-1", activeAt.toISOString()]);
  });

  it("binds both offering and versioned rule identity when creating a snapshot source", async () => {
    const pool = new RecordingPool();
    pool.rows = [activeRow];
    const store = new PostgresCatalogStore(pool, secrets);
    const activeAt = new Date("2025-03-01T10:00:00.000Z");

    await expect(store.findActivePricingRule("offering-1", "pricing-v2", activeAt))
      .resolves.toMatchObject({ id: "pricing-v2", version: 2 });

    expect(pool.calls[0]?.text).toMatch(/pr\.service_offering_id = \$1[\s\S]*pr\.id = \$2/iu);
    expect(pool.calls[0]?.values).toEqual(["offering-1", "pricing-v2", activeAt.toISOString()]);
  });
});

class AvailabilityConnection implements SqlConnection {
  readonly calls: { text: string; values: readonly unknown[] }[] = [];
  released = false;

  async query<Row extends object>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    const now = new Date("2025-03-01T10:00:00.000Z");
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes("FOR UPDATE OF t, ta")) {
      rows = [{
        tractor_id: "tractor-1",
        operational_status: "ONLINE",
        eligibility_status: "ELIGIBLE",
        tractor_version: 4,
        availability_version: 2,
        effective_at: new Date("2025-02-01T10:00:00.000Z"),
      }];
    } else if (text.includes("registration_number_ciphertext") && text.includes("FOR UPDATE")) {
      rows = [{
        id: "tractor-1",
        brand: "Mahindra",
        model: "575 DI",
        registration_number_ciphertext: new Uint8Array([1]),
        manufacturing_year: 2022,
        operational_status: "ONLINE",
        location_updated_at: now,
      }];
    } else if (text.includes("DISTINCT upper(document_kind)")) {
      rows = [
        { document_kind: "REGISTRATION_CERTIFICATE" },
        { document_kind: "INSURANCE" },
      ];
    } else if (text.includes("FROM public.service_offerings so") && text.includes("LIMIT 1")) {
      rows = [{ found: true }];
    } else if (text.includes("SET eligibility_status")) {
      rows = [];
    } else if (text.includes("SELECT EXISTS")) {
      rows = [{ found: false }];
    } else if (text.includes("UPDATE public.tractors") && text.includes("operational_status")) {
      rows = [{ version: 5, eligibility_status: "ELIGIBLE" }];
    } else if (text.includes("UPDATE public.tractor_availability")) {
      rows = [{ effective_at: now, version: 3 }];
    } else if (text.includes("INSERT INTO public.outbox_events")) {
      rows = [{
        id: "outbox-1",
        aggregate_type: "Tractor",
        aggregate_id: "tractor-1",
        event_type: "TractorAvailabilityChanged",
        event_version: 5,
        payload: { operationalStatus: "OFFLINE" },
        status: "PENDING",
        available_at: now,
        created_at: now,
      }];
    } else if (text.includes("INSERT INTO public.audit_events")) {
      rows = [{
        id: "audit-1",
        correlation_id: "corr-availability",
        pii_safe_metadata: { toStatus: "OFFLINE" },
        occurred_at: now,
      }];
    }
    return { rows: rows as readonly Row[], rowCount: rows.length };
  }

  release(): void {
    this.released = true;
  }
}

class AvailabilityPool implements SqlPool {
  constructor(readonly connection: AvailabilityConnection) {}
  async connect(): Promise<SqlConnection> { return this.connection; }
  async query<Row extends object>(): Promise<SqlQueryResult<Row>> {
    throw new Error("availability command must stay inside one transaction");
  }
}

/** Validates: Requirements 5.2, 5.3, 5.4, 5.5 */
describe("PostgresCatalogStore Tractor availability", () => {
  it("atomically records status history, audit, and realtime refresh projection without touching bookings", async () => {
    const connection = new AvailabilityConnection();
    const store = new PostgresCatalogStore(
      new AvailabilityPool(connection),
      secrets,
      undefined,
      () => new Date("2025-03-01T10:00:00.000Z"),
    );

    await expect(store.setTractorOperationalStatus(
      "owner-1",
      "tractor-1",
      "OFFLINE",
      4,
      "Owner break",
      {
        requiredDocumentKinds: ["REGISTRATION_CERTIFICATE", "INSURANCE"],
        maximumLocationAgeMs: 24 * 60 * 60 * 1000,
      },
      new Date("2025-03-01T10:00:00.000Z"),
      { correlationId: "corr-availability", actorChannel: "PWA" },
    )).resolves.toEqual({
      kind: "UPDATED",
      availability: {
        tractorId: "tractor-1",
        operationalStatus: "OFFLINE",
        eligibilityStatus: "ELIGIBLE",
        acceptingNewDemand: false,
        existingConfirmedBookingsManageable: true,
        effectiveAt: new Date("2025-03-01T10:00:00.000Z"),
        version: 5,
      },
    });

    const texts = connection.calls.map((call) => call.text);
    expect(texts[0]).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(texts.at(-1)).toBe("COMMIT");
    expect(texts.some((text) => text.includes("tractor_availability_history"))).toBe(true);
    expect(texts.some((text) => text.includes("outbox_events"))).toBe(true);
    expect(texts.some((text) => text.includes("audit_events"))).toBe(true);
    expect(texts.some((text) => /(?:UPDATE|DELETE)\s+public\.bookings/iu.test(text))).toBe(false);

    const outbox = connection.calls.find((call) => call.text.includes("outbox_events"));
    expect(outbox?.values).toEqual(expect.arrayContaining([
      "TractorAvailabilityChanged",
      5,
      expect.stringContaining('"existingConfirmedBookingsManageable":true'),
    ]));
    expect(connection.released).toBe(true);
  });
});