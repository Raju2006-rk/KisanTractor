import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { loadAttempt, runAuthoritativeAction, type StorageLike } from "./authoritative-action";
import { bookingRequestBody, createBookingDraft } from "./farmer-booking";

const propertyRuns = 300;
const seed = 17_040_005;

class MemoryStorage implements StorageLike {
  readonly entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
}

/**
 * The server's create-booking idempotency contract (Property 4): one key binds one command;
 * a replay returns the same booking and a changed command under the key is a conflict.
 */
class IdempotentBookingServer {
  readonly claims = new Map<string, { readonly digest: string; readonly bookingId: string }>();
  bookingsCreated = 0;
  handle(key: string, body: string): { status: number; bookingId?: string } {
    const digest = createHash("sha256").update(body).digest("hex");
    const claim = this.claims.get(key);
    if (claim) return claim.digest === digest ? { status: 201, bookingId: claim.bookingId } : { status: 409 };
    this.bookingsCreated += 1;
    const bookingId = `booking-${this.bookingsCreated}`;
    this.claims.set(key, { digest, bookingId });
    return { status: 201, bookingId };
  }
}

/** What happens to one press of "Confirm booking", or a pause with no press at all. */
type Step =
  | "OFFLINE_PRESS"
  | "RESPONSE_LOST" // the server applied it but the response never arrived
  | "SERVER_DOWN" // 503 before anything was applied
  | "APPLIED_THEN_500" // applied, then the gateway failed
  | "RECONNECT_AND_WAIT"; // connectivity returns; the user does nothing

const stepArbitrary = fc.constantFrom<Step>("OFFLINE_PRESS", "RESPONSE_LOST", "SERVER_DOWN", "APPLIED_THEN_500", "RECONNECT_AND_WAIT");

/** Validates: Requirements 8.5, 17.4 (client side of Property 4: Idempotent Booking Creation) */
describe("explicit same-key retry under intermittent connectivity", () => {
  it("creates exactly one booking and never sends without a press, for any failure sequence", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(stepArbitrary, { maxLength: 12 }),
      fc.integer({ min: 1, max: 30 * 60 * 1_000 }),
      async (steps, stepMs) => {
        const storage = new MemoryStorage();
        const server = new IdempotentBookingServer();
        const draft = createBookingDraft({ district: "Mysuru", start: "2027-01-02T08:00", end: "2027-01-02T12:00", tractorId: "tractor-1" });
        const sent: { key: string; body: string }[] = [];
        let clock = Date.parse("2027-01-01T05:00:00.000Z");
        let renders = 0;
        let onlinePresses = 0;

        const press = (online: boolean, network: Step | "OK") => {
          if (online) onlinePresses += 1;
          renders += 1;
          return runAuthoritativeAction({
            storage,
            actionId: "farmer:booking:create",
            // Every press may follow a reload, so the page offers a fresh key each time.
            renderedKey: `rendered-key-${renders}`,
            online,
            fields: {},
            stableValues: { capturedAt: new Date(clock).toISOString() },
            now: clock,
            send: async (attempt) => {
              const key = attempt.idempotencyKey!;
              const body = JSON.stringify(bookingRequestBody(draft, attempt.stableValues.capturedAt));
              sent.push({ key, body });
              if (network === "SERVER_DOWN") return { status: 503 };
              const result = server.handle(key, body);
              if (network === "RESPONSE_LOST") throw new TypeError("Failed to fetch");
              if (network === "APPLIED_THEN_500") return { status: 500 };
              return { status: result.status };
            },
          });
        };

        for (const step of steps) {
          clock += stepMs;
          if (step === "RECONNECT_AND_WAIT") continue;
          const result = await press(step !== "OFFLINE_PRESS", step);
          expect(result.outcome).toBe(step === "OFFLINE_PRESS" ? "NOT_SENT" : "UNKNOWN");
        }
        // No request is ever sent without an explicit online press: nothing was queued.
        expect(sent).toHaveLength(onlinePresses);

        clock += stepMs;
        const final = await press(true, "OK");
        expect(final.outcome).toBe("SUCCEEDED");
        expect(server.bookingsCreated).toBe(1);
        expect(new Set(sent.map((request) => request.key)).size).toBe(1);
        expect(new Set(sent.map((request) => request.body)).size).toBe(1);
        expect(sent[0]!.key).toBe("rendered-key-1");
        expect(loadAttempt(storage, "farmer:booking:create", clock)).toBeUndefined();
      },
    ), { numRuns: propertyRuns, seed });
  });
});
