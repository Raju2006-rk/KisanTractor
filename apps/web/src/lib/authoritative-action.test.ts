import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  attemptMaxAgeMs,
  attemptScope,
  beginAttempt,
  classifyHttpOutcome,
  clearAttemptFamily,
  isDeviceOnline,
  loadAttempt,
  resumeNotice,
  runAuthoritativeAction,
  sanitizeSafeDraft,
  saveAttempt,
  settleAttempt,
  type StorageLike,
} from "./authoritative-action";
import { bookingDraftOmittedPhone, bookingRequestBody, createBookingDraft, restoreBookingDraft, serializeSafeBookingDraft } from "./farmer-booking";

/** A real in-memory Web Storage, standing in for the tab's sessionStorage. */
class MemoryStorage implements StorageLike {
  readonly entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
}

/** A device whose connectivity the test flips, with a network that can drop responses. */
function intermittentDevice() {
  const sent: { key: string | undefined; capturedAt: string | undefined }[] = [];
  const device = {
    online: true,
    clock: Date.parse("2027-01-01T05:00:00.000Z"),
    /** "ok" | "lost" (request reached the server, response lost) | "server-error" */
    network: "ok" as "ok" | "lost" | "server-error" | "conflict",
    sent,
    storage: new MemoryStorage(),
  };
  const press = (renderedKey: string) => runAuthoritativeAction({
    storage: device.storage,
    actionId: "farmer:booking:create",
    renderedKey,
    online: device.online,
    fields: {},
    stableValues: { capturedAt: new Date(device.clock).toISOString() },
    now: device.clock,
    send: async (attempt) => {
      sent.push({ key: attempt.idempotencyKey, capturedAt: attempt.stableValues.capturedAt });
      if (device.network === "lost") throw new TypeError("Failed to fetch");
      return { status: device.network === "server-error" ? 503 : device.network === "conflict" ? 409 : 201 };
    },
  });
  return { device, press };
}

/** Validates: Requirements 17.4 */
describe("Authoritative Action outcomes", () => {
  it("treats timeouts, throttling, and server failures as unknown and other 4xx as definite refusals", () => {
    expect(classifyHttpOutcome(201)).toBe("SUCCEEDED");
    for (const status of [408, 425, 429, 500, 502, 503, 504]) expect(classifyHttpOutcome(status)).toBe("UNKNOWN");
    for (const status of [400, 401, 403, 404, 409, 422]) expect(classifyHttpOutcome(status)).toBe("REJECTED");
  });

  it("only trusts navigator.onLine when it says the device is offline", () => {
    expect(isDeviceOnline({ navigator: { onLine: false } })).toBe(false);
    expect(isDeviceOnline({ navigator: { onLine: true } })).toBe(true);
    expect(isDeviceOnline({ navigator: {} })).toBe(true);
  });

  it("keeps the key for unknown and unsent outcomes and ends the attempt otherwise", () => {
    const { attempt } = beginAttempt({ actionId: "job:b1:start", existing: undefined, renderedKey: "key-00000001", online: true, fields: {}, now: 0 });
    expect(settleAttempt(attempt, "UNKNOWN")).toMatchObject({ idempotencyKey: "key-00000001", state: "UNKNOWN" });
    expect(settleAttempt(attempt, "NOT_SENT")).toMatchObject({ idempotencyKey: "key-00000001", state: "NOT_SENT" });
    expect(settleAttempt(attempt, "SUCCEEDED")).toBeUndefined();
    expect(settleAttempt(attempt, "REJECTED")).toBeUndefined();
  });
});

/** Validates: Requirements 3.5, 17.4 */
describe("intermittent connectivity during an Authoritative Action", () => {
  it("sends nothing offline, never replays on reconnect, and retries explicitly with the same key", async () => {
    const { device, press } = intermittentDevice();

    device.online = false;
    const offline = await press("key-first-render");
    expect(offline.outcome).toBe("NOT_SENT");
    expect(device.sent).toHaveLength(0);

    // Reconnecting and waiting does not send anything: there is no queue or background replay.
    device.online = true;
    device.clock += 10 * 60 * 1_000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(device.sent).toHaveLength(0);

    // The page re-rendered with a new key, but the pending attempt's key wins.
    device.network = "lost";
    const lost = await press("key-second-render");
    expect(lost.outcome).toBe("UNKNOWN");
    expect(device.sent).toEqual([{ key: "key-first-render", capturedAt: "2027-01-01T05:00:00.000Z" }]);

    device.network = "server-error";
    expect((await press("key-third-render")).outcome).toBe("UNKNOWN");

    device.network = "ok";
    const done = await press("key-fourth-render");
    expect(done.outcome).toBe("SUCCEEDED");
    expect(done.resumedUnknown).toBe(true);
    // Every request was the same command under the same key, including the original capture time.
    expect(new Set(device.sent.map((request) => request.key))).toEqual(new Set(["key-first-render"]));
    expect(new Set(device.sent.map((request) => request.capturedAt))).toEqual(new Set(["2027-01-01T05:00:00.000Z"]));
    expect(loadAttempt(device.storage, "farmer:booking:create", device.clock)).toBeUndefined();

    // After success, the next action is a new request with a new key.
    await press("key-next-booking");
    expect(device.sent.at(-1)?.key).toBe("key-next-booking");
  });

  it("starts a new key after a definite refusal because nothing was recorded", async () => {
    const { device, press } = intermittentDevice();
    device.network = "conflict";
    expect((await press("key-conflicted")).outcome).toBe("REJECTED");
    device.network = "ok";
    await press("key-after-conflict");
    expect(device.sent.map((request) => request.key)).toEqual(["key-conflicted", "key-after-conflict"]);
  });

  it("restores a native form's key and entries when a sent request never reported back", () => {
    const storage = new MemoryStorage();
    const fields = sanitizeSafeDraft({ amountRupees: "700", receivedAt: "2027-01-01T10:30" }, ["amountRupees", "receivedAt"]);
    const sent = beginAttempt({ actionId: "cash:b1:record", existing: undefined, renderedKey: "cash-key-0001", online: true, fields, now: 1_000 });
    saveAttempt(storage, sent.attempt);

    // The browser lost the response; the next render offers a fresh key, which must not be used.
    const pending = loadAttempt(storage, "cash:b1:record", 2_000);
    expect(resumeNotice(pending, false)).toBe("UNKNOWN");
    expect(pending?.fields).toEqual({ amountRupees: "700", receivedAt: "2027-01-01T10:30" });
    const retry = beginAttempt({ actionId: "cash:b1:record", existing: pending, renderedKey: "cash-key-fresh", online: true, fields, now: 3_000 });
    expect(retry.attempt.idempotencyKey).toBe("cash-key-0001");

    // When the server's redirect reports the outcome, the whole family is settled.
    saveAttempt(storage, beginAttempt({ actionId: "cash:b1:retry", existing: undefined, renderedKey: "cash-key-0002", online: true, fields: {}, now: 1_000 }).attempt);
    expect(resumeNotice(pending, true)).toBe("NONE");
    clearAttemptFamily(storage, "cash:b1");
    expect(storage.entries.size).toBe(0);
  });

  it("blocks an offline press of a version-guarded action and restores its draft without a key", () => {
    const storage = new MemoryStorage();
    const blocked = beginAttempt({ actionId: "decision:b1:reject", existing: undefined, online: false, fields: { reason: "Tractor under repair" }, now: 0 });
    expect(blocked.decision).toBe("BLOCK_OFFLINE");
    saveAttempt(storage, blocked.attempt);
    const restored = loadAttempt(storage, "decision:b1:reject", 1_000);
    expect(resumeNotice(restored, false)).toBe("NOT_SENT");
    expect(restored?.idempotencyKey).toBeUndefined();
    expect(restored?.fields).toEqual({ reason: "Tractor under repair" });
  });

  it("drops expired, malformed, and tampered attempts", () => {
    const storage = new MemoryStorage();
    saveAttempt(storage, beginAttempt({ actionId: "job:b1:start", existing: undefined, renderedKey: "key-00000001", online: true, fields: {}, now: 0 }).attempt);
    expect(loadAttempt(storage, "job:b1:start", attemptMaxAgeMs + 1)).toBeUndefined();
    expect(storage.entries.size).toBe(0);

    storage.setItem("kisantractor:attempt:v1:job:b1:pause", "{not json");
    expect(loadAttempt(storage, "job:b1:pause", 0)).toBeUndefined();
    storage.setItem("kisantractor:attempt:v1:job:b1:resume", JSON.stringify({
      version: 1, actionId: "job:b1:resume", idempotencyKey: "bad key with spaces", state: "SENT", createdAt: 0, stableValues: {}, fields: {},
    }));
    expect(loadAttempt(storage, "job:b1:resume", 0)).toBeUndefined();
    expect(attemptScope("job", "booking/1 ?")).toBe("job:booking_1__");
  });
});

/** Validates: Requirements 3.5, 17.4 */
describe("safe drafts", () => {
  it("never keeps credentials, one-time codes, or payment-provider data", () => {
    const fields = sanitizeSafeDraft({
      reason: "Wrong acreage",
      accessToken: "eyJhbGciOi",
      otp: "123456",
      providerPayload: "{\"razorpay_signature\":\"x\"}",
      cardNumber: "4111111111111111",
      upiId: "farmer@upi",
      sessionId: "s-1",
      long: "x".repeat(2_001),
    }, ["reason", "accessToken", "otp", "providerPayload", "cardNumber", "upiId", "sessionId", "long"]);
    expect(fields).toEqual({ reason: "Wrong acreage" });
  });

  it("stores the booking draft without the Recipient phone and flags that it must be re-entered", () => {
    const draft = { ...createBookingDraft({ target: "SOMEONE_ELSE", district: "Mysuru" }), recipientName: "Ravi Kumar", coordinationPhone: "+919876543210", coordinationConsent: true };
    const stored = serializeSafeBookingDraft(draft);
    expect(stored).not.toContain("9876543210");
    expect(stored).not.toContain("coordinationConsent");
    expect(bookingDraftOmittedPhone(stored)).toBe(true);
    const restored = restoreBookingDraft(stored, createBookingDraft());
    expect(restored).toMatchObject({ recipientName: "Ravi Kumar", district: "Mysuru", coordinationPhone: "", coordinationConsent: false });
    // Drafts written before safe drafts may hold a phone; it is not restored.
    expect(restoreBookingDraft(JSON.stringify(draft), createBookingDraft()).coordinationPhone).toBe("");
  });

  it("builds the identical booking command for a retry that reuses the attempt's capture time", () => {
    const draft = createBookingDraft({ district: "Mysuru", start: "2027-01-02T08:00", end: "2027-01-02T12:00" });
    const capturedAt = "2027-01-01T05:00:00.000Z";
    expect(JSON.stringify(bookingRequestBody(draft, capturedAt))).toBe(JSON.stringify(bookingRequestBody(draft, capturedAt)));
    expect(bookingRequestBody(draft, capturedAt)).toMatchObject({ serviceLocation: { capturedAt } });
  });
});

/** Validates: Requirements 17.4 */
describe("no silent queue", () => {
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const files = (function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return /\.tsx?$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name) ? [path] : [];
    });
  })(sourceRoot);

  it("uses no background sync, persistent queue, or retry timer for actions", () => {
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((file) =>
      /SyncManager|sync\.register|backgroundFetch|periodicSync|localStorage|indexedDB/u.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("only display components react to reconnecting, and they never send requests", () => {
    const listeners = files.filter((file) => /addEventListener\(\s*["']online["']/u.test(readFileSync(file, "utf8")));
    expect(listeners.map((file) => file.replace(/\\/gu, "/").split("/src/")[1]).sort()).toEqual([
      "components/connectivity/connectivity-status.tsx",
      "components/connectivity/freshness-indicator.tsx",
    ]);
    for (const file of listeners) {
      expect(readFileSync(file, "utf8")).not.toMatch(/fetch\(|requestSubmit|\.submit\(|sendBeacon/u);
    }
  });
});
