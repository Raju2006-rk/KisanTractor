import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  InMemoryMetrics,
  METRIC_DEFINITIONS,
  OTHER_LABEL_VALUE,
  UNKNOWN_LABEL_VALUE,
  enumeratedSeriesBound,
  metricNames,
  type CounterName,
  type LabelSpec,
} from "./metrics.js";
import { redactLogFields } from "./redaction.js";

const propertyRuns = 300;
const seeds = {
  logRedaction: 18_010_001,
  labelCardinality: 18_020_001,
} as const;

const digits = (length: number) => fc.stringMatching(new RegExp(`^\\d{${length}}$`, "u"));
const upper = (length: number) => fc.stringMatching(new RegExp(`^[A-Z]{${length}}$`, "u"));

/** Indian mobile numbers in the formats people and providers actually use. */
const phoneArbitrary = fc.tuple(fc.constantFrom("6", "7", "8", "9"), digits(9), fc.integer({ min: 0, max: 4 }))
  .map(([first, rest, format]) => {
    const core = `${first}${rest}`;
    const text = [
      core,
      `+91${core}`,
      `+91 ${core.slice(0, 5)} ${core.slice(5)}`,
      `0${core}`,
      `${core.slice(0, 5)}-${core.slice(5)}`,
    ][format]!;
    return { text, secrets: [text, core] };
  });
const otpArbitrary = fc.oneof(digits(4), digits(6), digits(8)).map((text) => ({ text, secrets: [text] }));
const base64url = fc.stringMatching(/^[A-Za-z0-9_-]{8,24}$/u);
const jwtArbitrary = fc.tuple(base64url, base64url, base64url)
  .map(([a, b, c]) => ({ text: `eyJ${a}.${b}.${c}`, secrets: [`eyJ${a}.${b}.${c}`] }));
const bearerArbitrary = base64url.map((token) => ({ text: `Bearer ${token}`, secrets: [token] }));
const emailArbitrary = fc.emailAddress().map((text) => ({ text, secrets: [text] }));
const coordinateText = fc.tuple(
  fc.integer({ min: 8, max: 37 }),
  fc.integer({ min: 1_000, max: 999_999 }).filter((micro) => micro % 10 !== 0),
  fc.integer({ min: 68, max: 97 }),
  fc.integer({ min: 1_000, max: 999_999 }).filter((micro) => micro % 10 !== 0),
).map(([lat, latMicro, lng, lngMicro]) => {
  const text = `${lat}.${String(latMicro).padStart(6, "0")}, ${lng}.${String(lngMicro).padStart(6, "0")}`;
  return { text, secrets: [text] };
});
const plateArbitrary = fc.tuple(
  fc.constantFrom("AP", "TS", "KA", "TN", "MH", "DL", "KL"),
  digits(2),
  upper(2),
  digits(4),
  fc.constantFrom("", " ", "-"),
).map(([state, district, series, number, sep]) => {
  const text = [state, district, series, number].join(sep);
  return { text, secrets: [text] };
});
const signedUrlArbitrary = base64url
  .map((sig) => ({ text: `https://storage.example/private/doc.pdf?X-Amz-Signature=${sig}`, secrets: [sig] }));

/** Detectable personal or secret values: redaction must remove them wherever they appear. */
const detectableArbitrary = fc.oneof(
  phoneArbitrary,
  jwtArbitrary,
  bearerArbitrary,
  emailArbitrary,
  coordinateText,
  plateArbitrary,
  signedUrlArbitrary,
);

const neutralKey = fc.constantFrom("detail", "info", "context", "item", "entry", "meta", "extra", "summary");
const sensitiveKey = fc.constantFrom(
  "name", "recipientName", "customerName", "phone", "coordinationPhone", "otp", "otpCode",
  "accessToken", "refreshToken", "registrationNumber", "providerPayload", "recipient", "latitude",
  "longitude", "reason", "landmarkOrDirections", "address", "authorization",
);
const personName = fc.constantFrom("Ravi Kumar", "Lakshmi Devi", "Suresh Reddy", "Anitha", "Venkatesh");
const separator = fc.constantFrom(" ", ": ", " (", ", ", "\n");
const trailer = fc.constantFrom(" ", ")", ".", "", " failed");

interface Placement {
  readonly path: readonly string[];
  readonly value: unknown;
  readonly secrets: readonly string[];
}

/** Places a secret under a neutral key, either bare or embedded in free text. */
const neutralPlacement = fc.tuple(
  fc.array(neutralKey, { minLength: 1, maxLength: 4 }),
  detectableArbitrary,
  fc.boolean(),
  separator,
  trailer,
).map(([path, secret, embed, before, after]): Placement => ({
  path,
  value: embed ? `delivery note${before}${secret.text}${after}` : secret.text,
  secrets: secret.secrets,
}));

/** Places names, OTPs, exact coordinates, and secrets under sensitive keys, at any depth. */
const sensitivePlacement = fc.tuple(
  fc.array(neutralKey, { maxLength: 3 }),
  sensitiveKey,
  fc.oneof(
    personName.map((text) => ({ value: text as unknown, secrets: [text] })),
    otpArbitrary.map((otp) => ({ value: otp.text as unknown, secrets: otp.secrets })),
    detectableArbitrary.map((secret) => ({ value: secret.text as unknown, secrets: secret.secrets })),
    fc.tuple(personName, phoneArbitrary).map(([text, phone]) => ({
      value: { name: text, phone: phone.text } as unknown,
      secrets: [text, ...phone.secrets],
    })),
  ),
).map(([path, key, payload]): Placement => ({ path: [...path, key], value: payload.value, secrets: payload.secrets }));

/** A whole-value OTP or a high-precision coordinate number under a neutral key. */
const neutralScalarPlacement = fc.tuple(
  fc.array(neutralKey, { minLength: 1, maxLength: 3 }),
  fc.oneof(
    otpArbitrary.map((otp) => ({ value: otp.text as unknown, secrets: otp.secrets })),
    fc.tuple(fc.integer({ min: 8, max: 37 }), fc.integer({ min: 1_001, max: 999_999 }).filter((m) => m % 10 !== 0))
      .map(([whole, micro]) => {
        const value = Number(`${whole}.${String(micro).padStart(6, "0")}`);
        return { value: value as unknown, secrets: [String(value)] };
      }),
  ),
).map(([path, payload]): Placement => ({ path, value: payload.value, secrets: payload.secrets }));

const build = (placements: readonly Placement[]): Record<string, unknown> => {
  const root: Record<string, unknown> = { event: "test.event", correlationId: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f" };
  placements.forEach((placement, index) => {
    let node = root;
    const path = placement.path.map((segment, depth) => (depth === 0 ? `${segment}${index}` : segment));
    path.slice(0, -1).forEach((segment) => {
      const child = node[segment];
      if (typeof child !== "object" || child === null || Array.isArray(child)) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    });
    node[path.at(-1)!] = placement.value;
  });
  return root;
};

const labelValueArbitrary = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.uuid(),
  phoneArbitrary.map((phone) => phone.text),
  fc.constantFrom("GET", "POST", "2xx", "5xx", "ISSUED", "THROTTLED", "OVERLAP", "BookingAccepted", "/owner/bookings/:bookingId/job"),
  fc.constantFrom("/owner/bookings/70000000-0000-4000-8000-000000000001/job", "booking-12345", "user-998877"),
);

const counterNames = metricNames.filter((name) => METRIC_DEFINITIONS[name].kind === "counter") as CounterName[];

const allowed = (spec: LabelSpec, value: string): boolean =>
  value === OTHER_LABEL_VALUE || value === UNKNOWN_LABEL_VALUE
  || ("values" in spec ? spec.values.includes(value) : spec.pattern.test(value) && !/\d{3,}/u.test(value));

describe("observability properties", () => {
  /**
   * Structured logs never carry detectable personal data, whatever field or depth it is placed at.
   * **Validates: Requirements 12.2, 18.1**
   */
  it("redacts every generated phone, OTP, token, email, coordinate, plate, signed URL, and sensitive field", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(neutralPlacement, sensitivePlacement, neutralScalarPlacement), { minLength: 1, maxLength: 6 }),
        (placements) => {
          const serialized = JSON.stringify(redactLogFields(build(placements)));
          for (const placement of placements) {
            for (const secret of placement.secrets) expect(serialized).not.toContain(secret);
          }
          // The correlation ID stays so logs remain joinable.
          expect(serialized).toContain("6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f");
        },
      ),
      { numRuns: propertyRuns, seed: seeds.logRedaction },
    );
  });

  /**
   * Arbitrary label input never creates identifier-bearing or unbounded metric series.
   * **Validates: Requirements 18.1, 18.2**
   */
  it("normalizes any label input to declared, bounded label values", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(
          fc.constantFrom(...counterNames),
          fc.dictionary(fc.constantFrom("method", "route", "status_class", "outcome", "reason", "stage",
            "event_type", "resolution", "action", "aggregate", "locale", "userId", "phone", "bookingId"), labelValueArbitrary),
        ), { minLength: 1, maxLength: 40 }),
        (records) => {
          const metrics = new InMemoryMetrics();
          for (const [name, labels] of records) metrics.increment(name, labels as never);
          const samples = metrics.snapshot();
          for (const sample of samples) {
            const declared = METRIC_DEFINITIONS[sample.name].labels as Readonly<Record<string, LabelSpec>>;
            expect(Object.keys(sample.labels).sort()).toEqual(Object.keys(declared).sort());
            for (const [label, value] of Object.entries(sample.labels)) {
              expect(allowed(declared[label]!, value)).toBe(true);
            }
          }
          for (const name of new Set(records.map(([name]) => name))) {
            const bound = enumeratedSeriesBound(name);
            if (bound !== undefined) {
              expect(samples.filter((sample) => sample.name === name).length).toBeLessThanOrEqual(bound);
            }
          }
          const serialized = JSON.stringify(samples);
          expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
          expect(serialized).not.toMatch(/[6-9]\d{9}/u);
        },
      ),
      { numRuns: propertyRuns, seed: seeds.labelCardinality },
    );
  });
});
