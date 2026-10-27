import type { AuthPrincipal } from "@kisantractor/domain";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { BookingAuthorizationError, type BookingService } from "../booking/booking.service.js";
import type {
  JobSessionAuthenticator,
  JobStore,
  ValidatedJobAction,
  WorkSessionProjection,
  WorkSessionQuery,
} from "./job.contracts.js";
import { FarmerJobController, OwnerJobController } from "./job.controller.js";
import { InvalidJobSequenceError, JobService } from "./job.service.js";

const session: WorkSessionProjection = {
  bookingId: "70000000-0000-4000-8000-000000000001",
  bookingStatus: "FINAL_BILL_GENERATED",
  bookingVersion: 6,
  pricingMethod: "PER_ACRE",
  state: "COMPLETED",
  validNextActions: [],
  events: [],
  measurements: [],
  activeIntervals: [],
  activeMilliseconds: 0,
  activeMinutes: 0,
};

class FixedAuthenticator implements JobSessionAuthenticator {
  constructor(private readonly principal: AuthPrincipal) {}
  async authenticateAccessCredential(credential: string): Promise<AuthPrincipal> {
    if (credential !== "access-token") throw new Error("unexpected credential");
    return this.principal;
  }
}

class RecordingStore implements JobStore {
  actions: ValidatedJobAction[] = [];
  queries: WorkSessionQuery[] = [];
  failWith?: Error;
  async loadWorkSession(query: WorkSessionQuery) { this.queries.push(query); return session; }
  async recordAction(input: ValidatedJobAction) {
    if (this.failWith) throw this.failWith;
    this.actions.push(input);
    return session;
  }
  async correctWorkEvent() { return session; }
  async correctWorkMeasurement() { return session; }
}

const owner: AuthPrincipal = { userId: "owner-1", sessionId: "s-1", roles: ["OWNER", "FARMER"] };
const farmer: AuthPrincipal = { userId: "farmer-1", sessionId: "s-2", roles: ["FARMER", "OWNER"] };
const request = { headers: { authorization: "Bearer access-token", "x-client-channel": "PWA" } };
const now = () => new Date("2026-03-01T10:00:00.000Z");

const httpError = async (promise: Promise<unknown>): Promise<HttpException> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
};

/** Validates: Requirements 2.3, 2.6, 9.1, 9.2, 9.3, 9.5 */
describe("OwnerJobController", () => {
  it("forwards a stable idempotency key and completed quantity under the authenticated Owner", async () => {
    const store = new RecordingStore();
    const controller = new OwnerJobController(new FixedAuthenticator(owner), new JobService(store, now));

    await expect(controller.act(request, "70000000-0000-4000-8000-000000000001", "complete", { idempotencyKey: "key-12345678", completedQuantity: "2.50" }, "corr-1"))
      .resolves.toBe(session);
    expect(store.actions[0]).toMatchObject({
      bookingId: "70000000-0000-4000-8000-000000000001", action: "COMPLETE", actorId: "owner-1", idempotencyKey: "key-12345678", completedQuantity: "2.5",
    });

    await controller.session(request, "70000000-0000-4000-8000-000000000001");
    expect(store.queries).toEqual([{ bookingId: "70000000-0000-4000-8000-000000000001", viewerId: "owner-1", viewerRole: "OWNER" }]);
  });

  it("reports out-of-sequence actions with the current state and valid next actions", async () => {
    const store = new RecordingStore();
    store.failWith = new InvalidJobSequenceError("Cannot pause work", "PAUSED", ["RESUME", "COMPLETE"]);
    const controller = new OwnerJobController(new FixedAuthenticator(owner), new JobService(store, now));

    const conflict = await httpError(controller.act(request, "70000000-0000-4000-8000-000000000001", "pause", { idempotencyKey: "key-12345678" }));
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).toMatchObject({
      code: "WORK_EVENT_OUT_OF_SEQUENCE", currentState: "PAUSED", validNextActions: ["RESUME", "COMPLETE"],
    });

    expect((await httpError(controller.act(request, "70000000-0000-4000-8000-000000000001", "delete", { idempotencyKey: "key-12345678" }))).getStatus()).toBe(404);
    expect((await httpError(controller.act(request, "70000000-0000-4000-8000-000000000001", "start", {}))).getStatus()).toBe(422);
    expect((await httpError(controller.session({ headers: {} }, "70000000-0000-4000-8000-000000000001"))).getStatus()).toBe(401);
  });
});

/** Validates: Requirements 2.4, 10.6, 10.8 */
describe("FarmerJobController", () => {
  it("reads as the booking Farmer and disputes strictly in the Farmer role", async () => {
    const store = new RecordingStore();
    const transitions: unknown[][] = [];
    const bookings = {
      async transitionLifecycle(...args: unknown[]) {
        transitions.push(args);
        return { id: "70000000-0000-4000-8000-000000000001", status: "DISPUTED" };
      },
    } as unknown as BookingService;
    const controller = new FarmerJobController(new FixedAuthenticator(farmer), new JobService(store, now), bookings);

    await controller.session(request, "70000000-0000-4000-8000-000000000001");
    expect(store.queries).toEqual([{ bookingId: "70000000-0000-4000-8000-000000000001", viewerId: "farmer-1", viewerRole: "FARMER" }]);

    await expect(controller.dispute(request, "70000000-0000-4000-8000-000000000001", { expectedVersion: 6, reason: "Only 2 acres were ploughed" }, "corr-2"))
      .resolves.toMatchObject({ status: "DISPUTED" });
    expect(transitions[0]).toEqual([
      { ...farmer, roles: ["FARMER"] },
      { bookingId: "70000000-0000-4000-8000-000000000001", expectedVersion: 6, reason: "Only 2 acres were ploughed" },
      { correlationId: "corr-2", actorChannel: "PWA" },
      "DISPUTE",
    ]);
  });

  it("hides bookings the Farmer is not related to", async () => {
    const bookings = {
      async transitionLifecycle() { throw new BookingAuthorizationError(); },
    } as unknown as BookingService;
    const controller = new FarmerJobController(new FixedAuthenticator(farmer), new JobService(new RecordingStore(), now), bookings);
    expect((await httpError(controller.dispute(request, "70000000-0000-4000-8000-000000000002", { expectedVersion: 1, reason: "Wrong" }))).getStatus()).toBe(404);
  });
});
