import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getLauncherScript } from "../../../checkout-launcher.js/route";
import { GET as getCheckoutPage } from "../../../farmer/pay/[paymentId]/route";
import { checkoutContentSecurityPolicy, checkoutLauncherScript, RAZORPAY_CHECKOUT_SCRIPT_URL } from "../../../../lib/payment-checkout-page";
import { classifyPwaRequest, pwaCachePolicy } from "../../../../lib/pwa-cache-policy";
import { POST as startOnline } from "../bookings/[bookingId]/payments/online/route";
import { POST as paymentAction } from "./[paymentId]/[action]/route";

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

const BOOKING = "11111111-1111-4111-8111-111111111111";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const PAYMENT = "33333333-3333-4333-8333-333333333333";
const origin = "http://localhost:3000";
const form = (path: string, values: Record<string, string>) => new Request(`${origin}${path}`, {
  method: "POST",
  body: new URLSearchParams(values),
  headers: { "content-type": "application/x-www-form-urlencoded" },
});
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const location = (response: Response) => new URL(response.headers.get("location")!);
const checkoutBody = {
  payment: { id: PAYMENT, status: "PENDING" }, bookingId: BOOKING, bookingReference: "KT-2026-0001",
  checkout: { provider: "razorpay", mode: "SANDBOX", testMode: true, publicKey: "rzp_test_Kt0Synthetic01", providerReference: "order_KtSynthOrder01",
    amountPaise: 120_000, currency: "INR" },
  checkoutExpiresAt: "2026-03-01T12:45:00.000Z",
};

/** Validates: Requirements 2.6, 11.3, 11.4, 14.2, 14.3, 17.2, 17.4 */
describe("Farmer online payment routes", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    cookieGet.mockImplementation((name: string) => (name === "kt_access_token" ? { value: "farmer-session" } : undefined));
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const start = (values: Record<string, string>) =>
    startOnline(form(`/api/farmer/bookings/${BOOKING}/payments/online`, values), { params: Promise.resolve({ bookingId: BOOKING }) });
  const valid = { idempotencyKey: "online-key-0001", invoiceId: INVOICE, amountPaise: "120000" };

  it("starts a payment with the stable key and sends the Farmer to the checkout launcher", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ payment: { id: PAYMENT }, checkout: {} }, 201));
    const response = await start(valid);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/farmer/pay/${PAYMENT}?booking=${BOOKING}`);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://localhost:4100/farmer/bookings/${BOOKING}/payments/online`);
    expect(JSON.parse(String(init?.body))).toEqual({ invoiceId: INVOICE, amountPaise: 120_000, idempotencyKey: "online-key-0001" });
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("online-key-0001");
  });

  it("keeps the key for an explicit retry only after an unknown outcome, and refuses bad input locally", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    expect(Object.fromEntries(location(await start(valid)).searchParams)).toEqual({ online: "offline", onlineKey: "online-key-0001", onlineAmount: "120000" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "PAYMENT_OVERPAYMENT" }, 409));
    expect(location(await start(valid)).search).toBe("?online=overpayment");
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "CAPABILITY_UNAVAILABLE", state: "UNCONFIGURED" }, 503));
    expect(location(await start(valid)).search).toBe("?online=unavailable");
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "PROVIDER_REJECTED_REQUEST" }, 502));
    expect(location(await start(valid)).search).toBe("?online=failed");
    fetchMock.mockClear();
    for (const values of [{ ...valid, amountPaise: "99" }, { ...valid, amountPaise: "12.5" }, { ...valid, idempotencyKey: "" }, { ...valid, invoiceId: "nope" }]) {
      expect(location(await start(values)).search).toBe("?online=invalid");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    cookieGet.mockReturnValue(undefined);
    expect((await start(valid)).status).toBe(401);
  });

  const act = (action: string, values: Record<string, string>) =>
    paymentAction(form(`/api/farmer/payments/${PAYMENT}/${action}`, values), { params: Promise.resolve({ paymentId: PAYMENT, action }) });

  it("never forwards what the checkout claimed, and reports the stored outcome", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ confirmation: "AWAITING_PROVIDER_CONFIRMATION", payment: { status: "PENDING" } }));
    const returned = await act("checkout-return", {
      bookingId: BOOKING, outcome: "returned", razorpay_payment_id: "pay_claimed", razorpay_signature: "a".repeat(64),
    });
    expect(returned.headers.get("location")).toBe(`${origin}/farmer/bookings/${BOOKING}?online=returned#payment-feedback`);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://localhost:4100/farmer/payments/${PAYMENT}/checkout-return`);
    expect(init?.body).toBe("{}");

    fetchMock.mockResolvedValueOnce(jsonResponse({ confirmation: "CONFIRMED" }));
    expect(location(await act("status-check", { bookingId: BOOKING })).searchParams.get("online")).toBe("confirmed");
    fetchMock.mockResolvedValueOnce(jsonResponse({ confirmation: "NOT_COMPLETED", released: true }));
    expect(location(await act("cancel", { bookingId: BOOKING })).searchParams.get("online")).toBe("cancelled");
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "PAYMENT_IN_PROGRESS" }, 409));
    expect(location(await act("cancel", { bookingId: BOOKING })).searchParams.get("online")).toBe("in-progress");
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    expect(location(await act("cancel", { bookingId: BOOKING })).searchParams.get("online")).toBe("offline");
    // A malformed booking id never becomes part of the redirect.
    fetchMock.mockResolvedValueOnce(jsonResponse({ confirmation: "AWAITING_PROVIDER_CONFIRMATION" }));
    expect(location(await act("status-check", { bookingId: "../../evil" })).pathname).toBe("/farmer/payments");
    expect((await act("refund", { bookingId: BOOKING })).status).toBe(404);
  });

  const page = (paymentId = PAYMENT, query = `?booking=${BOOKING}`) =>
    getCheckoutPage(new Request(`${origin}/farmer/pay/${paymentId}${query}`), { params: Promise.resolve({ paymentId }) });

  it("serves the checkout launcher with a strict, page-only policy and the provider script only for a real checkout", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(checkoutBody));
    const response = await page();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(checkoutContentSecurityPolicy);
    expect(checkoutContentSecurityPolicy).toContain("default-src 'none'");
    expect(checkoutContentSecurityPolicy).toContain("script-src 'self' https://checkout.razorpay.com");
    expect(checkoutContentSecurityPolicy).toContain("form-action 'self'");
    expect(checkoutContentSecurityPolicy).not.toContain("unsafe-eval");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const html = await response.text();
    expect(html).toContain(`<script defer src="${RAZORPAY_CHECKOUT_SCRIPT_URL}"></script>`);
    expect(html).toContain('<script defer src="/checkout-launcher.js"></script>');
    // No inline script: every <script> element names a source.
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/gu)).toBeNull();
    expect(html).toContain('data-key="rzp_test_Kt0Synthetic01"');
    expect(html).toContain('data-order="order_KtSynthOrder01"');
    expect(html).toContain("Test service (sandbox)");
    expect(html).toContain(`action="/api/farmer/payments/${PAYMENT}/checkout-return"`);
    expect(html).not.toMatch(/farmer-session|Bearer/u);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://localhost:4100/farmer/payments/${PAYMENT}/checkout`);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer farmer-session");
  });

  it("loads no provider script when no checkout can be opened", async () => {
    for (const [status, body, expected, text] of [
      [503, { code: "CAPABILITY_UNAVAILABLE" }, 503, "Online payment is not available right now"],
      [409, { code: "PAYMENT_CHECKOUT_EXPIRED" }, 409, "The time to complete this payment has passed"],
      [409, { code: "PAYMENT_NOT_PENDING" }, 409, "no longer waiting to be paid"],
      [404, { code: "NOT_FOUND" }, 404, "unavailable for this account"],
      [200, { ...checkoutBody, checkout: { ...checkoutBody.checkout, publicKey: "evil" } }, 502, "could not be prepared"],
    ] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse(body, status));
      const response = await page();
      expect(response.status, String(status)).toBe(expected);
      const html = await response.text();
      expect(html).toContain(text);
      expect(html).not.toContain("<script");
      expect(html).toContain(`href="/farmer/bookings/${BOOKING}#payment-section"`);
    }
    cookieGet.mockReturnValue(undefined);
    const login = await page();
    expect(login.status).toBe(303);
    expect(location(login).pathname).toBe("/login");
  });

  it("serves the launcher script as static JavaScript that never sends the checkout's claims anywhere", async () => {
    const response = getLauncherScript();
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe(checkoutLauncherScript);
    expect(checkoutLauncherScript).not.toMatch(/razorpay_payment_id|razorpay_signature|fetch\(|XMLHttpRequest/u);
    expect(checkoutLauncherScript).toContain('finish("returned")');
    expect(checkoutLauncherScript).toContain('finish("dismissed")');
  });

  it("keeps the checkout page and launcher out of the service worker cache", () => {
    const scope = "https://kisantractor.test";
    for (const path of [`/farmer/pay/${PAYMENT}`, "/checkout-launcher.js", `/api/farmer/payments/${PAYMENT}/cancel`]) {
      expect(classifyPwaRequest(pwaCachePolicy, { method: "GET", url: `${scope}${path}` }, scope).action, path).toBe("bypass");
    }
  });
});
