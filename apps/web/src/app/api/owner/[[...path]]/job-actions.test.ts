import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as disputePOST } from "../../farmer/bookings/[bookingId]/dispute/route";
import { GET, POST } from "./route";

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

const form = (path: string, values: Record<string, string>) => new Request(`http://localhost:3000${path}`, {
  method: "POST",
  body: new URLSearchParams(values),
  headers: { "content-type": "application/x-www-form-urlencoded" },
});
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const ownerContext = (path: string[]) => ({ params: Promise.resolve({ path }) });

/** Validates: Requirements 2.6, 9.1, 9.2, 9.3, 17.4 */
describe("Owner job action proxy", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    cookieGet.mockReturnValue({ value: "owner-session" });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("forwards the stable key and completed quantity, then returns to the booking", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ bookingId: "booking-1" }));
    const response = await POST(
      form("/api/owner/bookings/booking-1/job/complete", { idempotencyKey: "complete-key-1", completedQuantity: "2.5" }),
      ownerContext(["bookings", "booking-1", "job", "complete"]),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/owner/bookings/booking-1?job=saved#job-feedback");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:4100/owner/bookings/booking-1/job/complete");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ idempotencyKey: "complete-key-1", completedQuantity: "2.5" }) });
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("complete-key-1");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer owner-session");
  });

  it("keeps the same key for an explicit retry after a lost connection and never queues the action", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    const response = await POST(
      form("/api/owner/bookings/booking-1/job/pause", { idempotencyKey: "pause-key-0001" }),
      ownerContext(["bookings", "booking-1", "job", "pause"]),
    );

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/owner/bookings/booking-1");
    expect(Object.fromEntries(location.searchParams)).toEqual({ jobError: "offline", retryAction: "PAUSE", retryKey: "pause-key-0001" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports out-of-sequence rejections without a retry key and rejects unknown or keyless actions", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "WORK_EVENT_OUT_OF_SEQUENCE", validNextActions: ["RESUME"] }, 409));
    const sequence = await POST(
      form("/api/owner/bookings/booking-1/job/pause", { idempotencyKey: "pause-key-0001" }),
      ownerContext(["bookings", "booking-1", "job", "pause"]),
    );
    expect(new URL(sequence.headers.get("location")!).search).toBe("?jobError=sequence");

    const unknown = await POST(form("/api/owner/bookings/booking-1/job/delete", { idempotencyKey: "pause-key-0001" }),
      ownerContext(["bookings", "booking-1", "job", "delete"]));
    expect(unknown.status).toBe(404);
    const read = await GET(new Request("http://localhost:3000/api/owner/bookings/booking-1/job"), ownerContext(["bookings", "booking-1", "job"]));
    expect(read.status).toBe(404);
    const keyless = await POST(form("/api/owner/bookings/booking-1/job/start", {}), ownerContext(["bookings", "booking-1", "job", "start"]));
    expect(new URL(keyless.headers.get("location")!).search).toBe("?jobError=invalid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires an authenticated session before forwarding", async () => {
    cookieGet.mockReturnValue(undefined);
    const response = await POST(form("/api/owner/bookings/booking-1/job/start", { idempotencyKey: "start-key-0001" }),
      ownerContext(["bookings", "booking-1", "job", "start"]));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** Validates: Requirements 2.4, 10.8 */
describe("Farmer bill dispute route", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const disputeContext = { params: Promise.resolve({ bookingId: "booking-1" }) };

  beforeEach(() => {
    cookieGet.mockReturnValue({ value: "farmer-session" });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("forwards the reason with the booking version and confirms the recorded dispute", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "booking-1", status: "DISPUTED" }));
    const response = await disputePOST(
      form("/api/farmer/bookings/booking-1/dispute", { expectedVersion: "7", reason: "Only 2 acres were ploughed" }),
      disputeContext,
    );

    expect(response.headers.get("location")).toBe("http://localhost:3000/farmer/bookings/booking-1?dispute=disputed#job-feedback");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4100/farmer/bookings/booking-1/dispute", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedVersion: 7, reason: "Only 2 acres were ploughed" }),
    }));
  });

  it("rejects a missing reason locally and reports version conflicts", async () => {
    const invalid = await disputePOST(form("/api/farmer/bookings/booking-1/dispute", { expectedVersion: "7", reason: " " }), disputeContext);
    expect(new URL(invalid.headers.get("location")!).search).toBe("?dispute=invalid");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "BOOKING_CONFLICT" }, 409));
    const conflict = await disputePOST(form("/api/farmer/bookings/booking-1/dispute", { expectedVersion: "6", reason: "Wrong acres" }), disputeContext);
    expect(new URL(conflict.headers.get("location")!).search).toBe("?dispute=conflict");
  });
});
