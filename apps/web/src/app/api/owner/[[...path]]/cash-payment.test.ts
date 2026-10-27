import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

const path = ["bookings", "booking-1", "payments", "cash"];
const context = { params: Promise.resolve({ path }) };
const form = (values: Record<string, string>) => new Request("http://localhost:3000/api/owner/bookings/booking-1/payments/cash", {
  method: "POST",
  body: new URLSearchParams(values),
  headers: { "content-type": "application/x-www-form-urlencoded" },
});
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const location = (response: Response) => new URL(response.headers.get("location")!);
const valid = { idempotencyKey: "cash-key-0001", invoiceId: "invoice-1", amountRupees: "700.50", receivedAt: "2026-03-01T17:25" };

/** Validates: Requirements 2.6, 11.2, 11.7, 17.4 */
describe("Owner cash record proxy", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    cookieGet.mockReturnValue({ value: "owner-session" });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T12:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("forwards integer paise, the India-time receipt instant, and the stable key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ payment: { id: "payment-2" } }, 201));
    const response = await POST(form(valid), context);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/owner/bookings/booking-1?cash=recorded#payment-feedback");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:4100/owner/bookings/booking-1/payments/cash");
    expect(JSON.parse(String(init?.body))).toEqual({
      invoiceId: "invoice-1", amountPaise: 70_050, idempotencyKey: "cash-key-0001", receivedAt: "2026-03-01T11:55:00.000Z",
    });
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("cash-key-0001");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer owner-session");
  });

  it("returns the same key and values for an explicit retry after a lost connection, without queueing", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    const response = await POST(form(valid), context);

    expect(Object.fromEntries(location(response).searchParams)).toEqual({
      cashError: "offline", cashKey: "cash-key-0001", cashAmount: "700.50", cashReceivedAt: "2026-03-01T17:25",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "INTERNAL" }, 500));
    const failed = await POST(form(valid), context);
    expect(location(failed).searchParams.get("cashError")).toBe("failed");
    expect(location(failed).searchParams.get("cashKey")).toBe("cash-key-0001");
  });

  it("reports definite rejections without a retry key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "PAYMENT_OVERPAYMENT" }, 409));
    expect(location(await POST(form(valid), context)).search).toBe("?cashError=overpayment");
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "PAYMENT_SETTLEMENT_BLOCKED" }, 409));
    expect(location(await POST(form(valid), context)).search).toBe("?cashError=blocked");
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "IDEMPOTENCY_KEY_REUSED" }, 409));
    expect(location(await POST(form(valid), context)).search).toBe("?cashError=conflict");
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "PAYMENT_VALIDATION_FAILED" }, 422));
    expect(location(await POST(form(valid), context)).search).toBe("?cashError=invalid");
  });

  it("rejects fractional paise, future receipt times, and keyless submissions locally", async () => {
    for (const values of [
      { ...valid, amountRupees: "700.505" },
      { ...valid, amountRupees: "0" },
      { ...valid, receivedAt: "2026-03-01T18:01" },
      { ...valid, receivedAt: "yesterday" },
      { ...valid, idempotencyKey: "" },
    ]) {
      expect(location(await POST(form(values), context)).search).toBe("?cashError=invalid");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await GET(new Request("http://localhost:3000/api/owner/bookings/booking-1/payments/cash"), context)).status).toBe(404);
  });

  it("requires an authenticated session", async () => {
    cookieGet.mockReturnValue(undefined);
    expect((await POST(form(valid), context)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
