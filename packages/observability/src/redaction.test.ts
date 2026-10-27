import { describe, expect, it } from "vitest";

import { REDACTED, containsSensitiveText, isSensitiveFieldName, redactError, redactLogFields } from "./redaction.js";

/** Validates: Requirements 12.2, 18.1 */
describe("redactLogFields", () => {
  it("redacts personal, secret, and provider-private fields by name", () => {
    const redacted = redactLogFields({
      phone: "+91 98765 43210",
      coordinationPhone: "9876543210",
      otpCode: "482913",
      accessToken: "opaque-token",
      authorization: "Bearer abc.def",
      recipientName: "Lakshmi Devi",
      name: "Ravi Kumar",
      latitude: 17.9689,
      longitude: 79.5941,
      registrationNumber: "AP03AB1234",
      providerPayload: { razorpay_signature: "sig", amount: 120000 },
      notificationRecipients: ["user-1", "user-2"],
      reason: "Call Ravi tomorrow",
      idempotencyKey: "key-1",
    });

    for (const value of Object.values(redacted)) expect(value).toBe(REDACTED);
  });

  it("keeps operational identifiers, codes, and counts", () => {
    const fields = {
      event: "outbox.event.published",
      correlationId: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      outboxEventId: "70000000-0000-4000-8000-000000000001",
      eventType: "BookingAccepted",
      attempt: 2,
      errorCode: "PROVIDER_TIMEOUT",
      reasonCode: "RATE_LIMITED",
      route: "/owner/bookings/:bookingId/job",
      statusCode: 409,
      durationMs: 12.3456,
      bookingId: "70000000-0000-4000-8000-000000000002",
    };
    expect(redactLogFields(fields)).toEqual(fields);
  });

  it("redacts sensitive values hidden in otherwise neutral fields", () => {
    const redacted = redactLogFields({
      detail: "SMS to +91 98765-43210 failed",
      contactInfo: "ravi@example.com",
      header: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
      point: "17.968912, 79.594134",
      vehicleMark: "KA 01 MX 9999",
      arrival: "vehicle TS09EA1234 arrived",
      bharat: "22 BH 1234 AA",
      submitted: "482913",
      grant: "https://storage.example/doc.pdf?X-Amz-Signature=abc",
      precise: 17.968912,
      digits: 9876543210,
    });
    for (const value of Object.values(redacted)) expect(value).toBe(REDACTED);
  });

  it("does not mistake UUIDs or trace IDs for phone numbers or plates", () => {
    const ids = {
      correlationId: "91665544-0000-4000-8000-916655440000",
      note_id: "c0ffee00-ab12-3456-8000-000000000001",
      traceId: "91234567890123456789012345678901",
    };
    expect(redactLogFields({ correlationId: ids.correlationId, traceId: ids.traceId })).toEqual({
      correlationId: ids.correlationId,
      traceId: ids.traceId,
    });
    expect(redactLogFields({ resourceId: ids.note_id })).toEqual({ resourceId: ids.note_id });
  });

  it("keeps a provider callback body digest but redacts anything else under that name", () => {
    // A SHA-256 hex digest whose digit run would otherwise look like a phone number.
    const digest = `9876543210${"ab".repeat(27)}`;
    expect(redactLogFields({ eventDigest: digest })).toEqual({ eventDigest: digest });
    expect(redactLogFields({ eventDigest: "call 9876543210" })).toEqual({ eventDigest: REDACTED });
    expect(redactLogFields({ payloadDigest: digest })).toEqual({ payloadDigest: REDACTED });
  });

  it("reduces errors to a class name and a code, never the message or stack", () => {
    const error = Object.assign(new TypeError("SMS to 9876543210 for Ravi failed"), { code: "PROVIDER_TIMEOUT" });
    expect(redactError(error)).toEqual({ errorName: "TypeError", errorCode: "PROVIDER_TIMEOUT" });
    expect(redactError(new Error("boom"))).toEqual({ errorName: "Error", errorCode: "UNCLASSIFIED" });
    const nested = JSON.stringify(redactLogFields({ failure: error }));
    expect(nested).not.toMatch(/9876543210|Ravi|stack/u);
  });

  it("bounds depth, array length, and string length", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let index = 0; index < 10; index += 1) deep = { child: deep };
    expect(JSON.stringify(redactLogFields(deep))).toContain(REDACTED);
    const many = redactLogFields({ items: Array.from({ length: 200 }, (_, index) => index) });
    expect((many.items as readonly unknown[]).length).toBe(50);
    expect(String(redactLogFields({ text_blob: "a".repeat(2_000) }).text_blob)).toBe(REDACTED);
    expect(String(redactLogFields({ blob: "a".repeat(2_000) }).blob).length).toBeLessThan(600);
  });

  it("classifies field names by segment", () => {
    expect(isSensitiveFieldName("ownerPhoneNumber")).toBe(true);
    expect(isSensitiveFieldName("service_location_latitude")).toBe(true);
    expect(isSensitiveFieldName("x-api-key")).toBe(true);
    expect(isSensitiveFieldName("errorCode")).toBe(false);
    expect(isSensitiveFieldName("tractorId")).toBe(false);
    expect(containsSensitiveText("PROVIDER_TIMEOUT")).toBe(false);
    expect(containsSensitiveText("SQLSTATE_40001")).toBe(false);
  });
});
