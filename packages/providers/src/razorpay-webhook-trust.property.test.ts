import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ProviderWebhookRejectedError, type ProviderWebhookHeaders } from "./online-payment.js";
import { RazorpayPaymentAdapter } from "./razorpay-payment-adapter.js";

// Feature: kisantractor-platform, Property 12: Payment Trust and Deduplication (task 16.3).
// Adapter half: only the exact bytes signed with the webhook secret verify; every other delivery
// (wrong secret, tampered or re-serialized body, truncated, non-hex, or missing signature, or a
// browser checkout signature) is refused before the body is parsed. Verified events report the
// body's own facts and a stable event id, so the store can deduplicate them.
const propertyRuns = 300;
const seeds = { signatures: 1_603_201, verifiedFacts: 1_603_202 } as const;

// Synthetic credentials for this test only.
const KEY_ID = "rzp_test_Kt0Synthetic01";
const KEY_SECRET = "synthetic-key-secret-for-tests";
const WEBHOOK_SECRET = "synthetic-webhook-secret-for-tests";

const adapter = new RazorpayPaymentAdapter({ environment: "test", keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET });

const hmac = (secret: string, bytes: Uint8Array | string): string => createHmac("sha256", secret).update(bytes).digest("hex");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function runSeeded(name: string, seed: number, assertion: () => void, coverage?: () => string): void {
  try {
    assertion();
    console.info(`[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none${coverage === undefined ? "" : ` ${coverage()}`}`);
  } catch (error) {
    console.error(`[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`);
    throw error;
  }
}

const idChars = fc.constantFrom(..."ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789");
const idPart = (min: number, max: number) => fc.string({ unit: idChars, minLength: min, maxLength: max });

/** Documented Razorpay webhook shapes, with payer contact details a real payload carries. */
const providerBodyArbitrary = fc.record({
  event: fc.constantFrom("payment.captured", "order.paid", "payment.failed", "payment.authorized", "refund.processed", "refund.failed"),
  orderId: idPart(8, 20).map((suffix) => `order_${suffix}`),
  paymentId: idPart(8, 20).map((suffix) => `pay_${suffix}`),
  refundId: idPart(8, 20).map((suffix) => `rfnd_${suffix}`),
  amount: fc.integer({ min: 100, max: 100_000_000 }),
  currency: fc.constantFrom("INR", "INR", "INR", "USD"),
  createdAt: fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
  spacing: fc.constantFrom<number | undefined>(undefined, undefined, 2),
}).map((spec) => {
  const payment = {
    id: spec.paymentId, entity: "payment", amount: spec.amount, currency: spec.currency,
    status: spec.event === "payment.failed" ? "failed" : spec.event === "payment.authorized" ? "authorized" : "captured",
    order_id: spec.orderId, method: "upi", captured: spec.event === "payment.captured" || spec.event === "order.paid",
    email: "payer.kisan@example.invalid", contact: "+919812345678",
  };
  const refund = {
    id: spec.refundId, entity: "refund", amount: spec.amount, currency: spec.currency, payment_id: spec.paymentId,
    receipt: "ktrf0123456789abcdef0123456789abcdef", status: spec.event === "refund.failed" ? "failed" : "processed",
  };
  const payload = spec.event.startsWith("refund.") ? { refund: { entity: refund } }
    : spec.event === "order.paid" ? { payment: { entity: payment }, order: { entity: { id: spec.orderId, entity: "order", status: "paid" } } }
      : { payment: { entity: payment } };
  return {
    spec,
    text: JSON.stringify({
      entity: "event", account_id: "acc_KtSynthAcct01", event: spec.event, contains: Object.keys(payload), payload, created_at: spec.createdAt,
    }, null, spec.spacing),
  };
});

/** Any body at all: provider-shaped JSON, arbitrary JSON, or arbitrary bytes. */
const anyBodyArbitrary: fc.Arbitrary<Uint8Array> = fc.oneof(
  { weight: 4, arbitrary: providerBodyArbitrary.map((body) => new TextEncoder().encode(body.text)) },
  { weight: 1, arbitrary: fc.json().map((text) => new TextEncoder().encode(text)) },
  { weight: 1, arbitrary: fc.uint8Array({ minLength: 1, maxLength: 512 }) },
);

type InvalidSignature =
  | { readonly mode: "WRONG_SECRET"; readonly secret: string }
  | { readonly mode: "TAMPERED_BODY"; readonly index: number; readonly mask: number }
  | { readonly mode: "APPENDED_BYTES"; readonly extra: Uint8Array }
  | { readonly mode: "RESERIALIZED" }
  | { readonly mode: "TRUNCATED"; readonly length: number }
  | { readonly mode: "NON_HEX"; readonly index: number; readonly char: string }
  | { readonly mode: "EXTENDED" }
  | { readonly mode: "MISSING" }
  | { readonly mode: "BLANK" }
  | { readonly mode: "CHECKOUT_SIGNATURE" }
  | { readonly mode: "SIGNED_WITH_KEY_SECRET" };

const invalidSignatureArbitrary: fc.Arbitrary<InvalidSignature> = fc.oneof(
  fc.record({ mode: fc.constant("WRONG_SECRET" as const),
    secret: fc.string({ minLength: 16, maxLength: 64 }).filter((secret) => secret.trim() !== WEBHOOK_SECRET) }),
  fc.record({ mode: fc.constant("TAMPERED_BODY" as const), index: fc.nat(), mask: fc.integer({ min: 1, max: 255 }) }),
  fc.record({ mode: fc.constant("APPENDED_BYTES" as const), extra: fc.uint8Array({ minLength: 1, maxLength: 8 }) }),
  fc.constant({ mode: "RESERIALIZED" as const }),
  fc.record({ mode: fc.constant("TRUNCATED" as const), length: fc.integer({ min: 1, max: 63 }) }),
  fc.record({ mode: fc.constant("NON_HEX" as const), index: fc.nat({ max: 63 }), char: fc.constantFrom("g", "z", "-", "_", "+", "=") }),
  fc.constant({ mode: "EXTENDED" as const }),
  fc.constant({ mode: "MISSING" as const }),
  fc.constant({ mode: "BLANK" as const }),
  fc.constant({ mode: "CHECKOUT_SIGNATURE" as const }),
  fc.constant({ mode: "SIGNED_WITH_KEY_SECRET" as const }),
);

/** Signed bytes plus the bytes and headers actually delivered. */
function deliveryFor(body: Uint8Array, invalid: InvalidSignature, eventId: string | undefined) {
  const signed = hmac(WEBHOOK_SECRET, body);
  let sent = body;
  let signature: string | undefined = signed;
  switch (invalid.mode) {
    case "WRONG_SECRET": signature = hmac(invalid.secret, body); break;
    case "TAMPERED_BODY": {
      const copy = Uint8Array.from(body);
      const index = invalid.index % copy.length;
      copy[index] = copy[index]! ^ invalid.mask;
      sent = copy;
      break;
    }
    case "APPENDED_BYTES": sent = Uint8Array.from([...body, ...invalid.extra]); break;
    case "RESERIALIZED": {
      // A framework that parses and re-stringifies JSON changes the signed bytes.
      let reserialized: string;
      try {
        reserialized = JSON.stringify(JSON.parse(new TextDecoder().decode(body)), null, 1);
      } catch {
        reserialized = `${new TextDecoder().decode(body)} `;
      }
      sent = new TextEncoder().encode(reserialized);
      if (Buffer.from(sent).equals(Buffer.from(body))) sent = new TextEncoder().encode(`${reserialized}\n`);
      break;
    }
    case "TRUNCATED": signature = signed.slice(0, invalid.length); break;
    case "NON_HEX": signature = `${signed.slice(0, invalid.index)}${invalid.char}${signed.slice(invalid.index + 1)}`; break;
    case "EXTENDED": signature = `${signed}00`; break;
    case "MISSING": signature = undefined; break;
    case "BLANK": signature = "   "; break;
    // What a browser holds after checkout: HMAC(order_id|payment_id) with the API key secret.
    case "CHECKOUT_SIGNATURE": signature = hmac(KEY_SECRET, "order_KtSynthOrder01|pay_KtSynthPay0001"); break;
    case "SIGNED_WITH_KEY_SECRET": signature = hmac(KEY_SECRET, body); break;
  }
  const headers: Record<string, string> = {
    ...(signature === undefined ? {} : { "x-razorpay-signature": signature }),
    ...(eventId === undefined ? {} : { "x-razorpay-event-id": eventId }),
  };
  return { sent, headers };
}

const eventIdArbitrary = fc.oneof(
  { weight: 3, arbitrary: idPart(8, 30) },
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constantFrom("bad id with spaces", "x".repeat(101), "", "evt/../1") },
);

type ValidVariant = "EXACT" | "UPPERCASE" | "PADDED" | "ARRAY_HEADER";

describe("Property 12: Payment Trust and Deduplication — Razorpay webhook verification", () => {
  /** **Validates: Requirements 11.4, 11.5** */
  it("refuses every delivery that is not the exact body signed with the webhook secret, before parsing it", () => {
    const seen = new Map<string, number>();
    runSeeded("razorpay-webhook-signature-trust", seeds.signatures, () => {
      fc.assert(fc.property(anyBodyArbitrary, invalidSignatureArbitrary, eventIdArbitrary, (body, invalid, eventId) => {
        const { sent, headers } = deliveryFor(body, invalid, eventId);
        let caught: unknown;
        try {
          adapter.verifyWebhook(sent, headers);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ProviderWebhookRejectedError);
        const rejection = caught as ProviderWebhookRejectedError;
        expect(rejection.code).toBe(invalid.mode === "MISSING" || invalid.mode === "BLANK" ? "SIGNATURE_MISSING" : "SIGNATURE_INVALID");
        // The digest of the delivered bytes is the only trace; nothing from the body is echoed.
        expect(rejection.payloadDigest).toBe(sha256(sent));
        expect(rejection.message).toBe(`Provider webhook rejected: ${rejection.code}`);
        seen.set(invalid.mode, (seen.get(invalid.mode) ?? 0) + 1);
      }), { seed: seeds.signatures, numRuns: propertyRuns });
    }, () => [...seen.entries()].map(([mode, count]) => `${mode}=${count}`).join(" "));
    expect(seen.size).toBe(11);
  });

  /** **Validates: Requirements 11.5, 11.6** */
  it("verifies exactly-signed bytes into the body's own facts with a stable event id", () => {
    let confirmations = 0;
    runSeeded("razorpay-webhook-verified-facts", seeds.verifiedFacts, () => {
      fc.assert(fc.property(
        providerBodyArbitrary,
        eventIdArbitrary,
        fc.constantFrom<ValidVariant>("EXACT", "EXACT", "UPPERCASE", "PADDED", "ARRAY_HEADER"),
        (body, eventId, variant) => {
          const bytes = new TextEncoder().encode(body.text);
          const signature = hmac(WEBHOOK_SECRET, bytes);
          const presented = variant === "UPPERCASE" ? signature.toUpperCase() : variant === "PADDED" ? `  ${signature}\t` : signature;
          const headers: ProviderWebhookHeaders = {
            "x-razorpay-signature": variant === "ARRAY_HEADER" ? [presented, "0".repeat(64)] : presented,
            ...(eventId === undefined ? {} : { "x-razorpay-event-id": eventId }),
          };
          const verify = () => {
            try {
              return { event: adapter.verifyWebhook(bytes, headers) };
            } catch (error) {
              return { error };
            }
          };
          const first = verify();
          const second = verify();
          // Verification is deterministic: the same bytes always yield the same event and id.
          expect(second).toEqual(first);
          const digest = sha256(bytes);
          if (first.error !== undefined) {
            // A correctly signed body is never refused for its signature; only an unusable payload is.
            expect(first.error).toBeInstanceOf(ProviderWebhookRejectedError);
            expect((first.error as ProviderWebhookRejectedError).code).toBe("PAYLOAD_INVALID");
            return;
          }
          const event = first.event!;
          const headerIdValid = eventId !== undefined && /^[A-Za-z0-9_-]{1,100}$/u.test(eventId.trim());
          expect(event.providerEventId).toBe(headerIdValid ? eventId!.trim() : `sha256:${digest}`);
          expect(event.eventIdSource).toBe(headerIdValid ? "HEADER" : "DIGEST");
          expect(event.payloadDigest).toBe(digest);
          expect(event.eventType).toBe(body.spec.event);
          // The facts the domain checks are exactly the body's; payer contact details are dropped.
          expect(event.amountPaise).toBe(body.spec.amount);
          expect(event.currency).toBe(body.spec.currency);
          expect(event.providerPaymentId).toBe(body.spec.paymentId);
          expect(JSON.stringify(event)).not.toContain("payer.kisan@example.invalid");
          expect(JSON.stringify(event)).not.toContain("+919812345678");
          const expectedKind = body.spec.event === "payment.captured" || body.spec.event === "order.paid" ? "PAYMENT_CONFIRMED"
            : body.spec.event === "payment.failed" ? "PAYMENT_ATTEMPT_FAILED"
              : body.spec.event === "refund.processed" ? "REFUND_CONFIRMED"
                : body.spec.event === "refund.failed" ? "REFUND_FAILED" : "INFORMATIONAL";
          expect(event.kind).toBe(expectedKind);
          if (body.spec.event.startsWith("refund.")) expect(event.providerRefundId).toBe(body.spec.refundId);
          else expect(event.providerReference).toBe(body.spec.orderId);
          if (event.kind === "PAYMENT_CONFIRMED") confirmations += 1;
        },
      ), { seed: seeds.verifiedFacts, numRuns: propertyRuns });
    }, () => `confirmations=${confirmations}`);
    expect(confirmations).toBeGreaterThan(0);
  });
});
