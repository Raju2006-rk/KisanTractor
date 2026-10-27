import { renderIvrPromptMessage } from "./ivr-prompt-catalogs.js";
import {
  IVR_PROMPT_TREE_VERSION,
  IvrPromptError,
  type IvrCollectedField,
  type IvrPendingEffectKind,
  type IvrPromptEffect,
  type IvrPromptLocale,
  type IvrPromptMessageKey,
  type IvrPromptNode,
  type IvrPromptPolicy,
  type IvrPromptSession,
  type IvrPromptState,
  type IvrPromptStep,
  type IvrPromptTree,
  type IvrPromptTurn,
  type IvrRenderedPrompt,
  type IvrSessionStatus,
} from "./ivr-prompt.contracts.js";

const promptNode = (
  state: IvrPromptState,
  step: IvrPromptStep,
  messageKey: IvrPromptMessageKey,
  acceptsInput = true,
): IvrPromptNode => Object.freeze({ state, step, messageKey, acceptsInput });

const VERSION_ONE_NODES: Readonly<Record<IvrPromptState, IvrPromptNode>> = Object.freeze({
  LANGUAGE: promptNode("LANGUAGE", "LANGUAGE", "ivr.language"),
  VERIFICATION: promptNode("VERIFICATION", "VERIFICATION", "ivr.verification"),
  PURPOSE: promptNode("PURPOSE", "VERIFICATION", "ivr.purpose"),
  LOCATION_METHOD: promptNode("LOCATION_METHOD", "LOCATION", "ivr.location.method"),
  SAVED_LOCATION: promptNode("SAVED_LOCATION", "LOCATION", "ivr.location.saved"),
  MANUAL_STATE: promptNode("MANUAL_STATE", "LOCATION", "ivr.location.state"),
  MANUAL_DISTRICT: promptNode("MANUAL_DISTRICT", "LOCATION", "ivr.location.district"),
  MANUAL_MANDAL: promptNode("MANUAL_MANDAL", "LOCATION", "ivr.location.mandal"),
  MANUAL_VILLAGE: promptNode("MANUAL_VILLAGE", "LOCATION", "ivr.location.village"),
  MANUAL_PIN: promptNode("MANUAL_PIN", "LOCATION", "ivr.location.pin"),
  SERVICE: promptNode("SERVICE", "SERVICE", "ivr.service"),
  DATE: promptNode("DATE", "DATE_TIME", "ivr.date"),
  TIME: promptNode("TIME", "DATE_TIME", "ivr.time"),
  QUANTITY: promptNode("QUANTITY", "QUANTITY", "ivr.quantity"),
  CONFIRMATION: promptNode("CONFIRMATION", "CONFIRMATION", "ivr.confirmation"),
  BOOKING_STATUS_REFERENCE: promptNode("BOOKING_STATUS_REFERENCE", "BOOKING_STATUS", "ivr.status.reference"),
  BOOKING_STATUS: promptNode("BOOKING_STATUS", "BOOKING_STATUS", "ivr.status.result"),
  COMPLETED: promptNode("COMPLETED", "CONFIRMATION", "ivr.completed", false),
  TRANSFERRED: promptNode("TRANSFERRED", "NONE", "ivr.transfer", false),
  TERMINATED: promptNode("TERMINATED", "NONE", "ivr.terminated", false),
});

export const IVR_PROMPT_TREES: Readonly<Record<number, IvrPromptTree>> = Object.freeze({
  [IVR_PROMPT_TREE_VERSION]: Object.freeze({
    version: IVR_PROMPT_TREE_VERSION,
    nodes: VERSION_ONE_NODES,
  }),
});

export const defaultIvrPromptPolicy: IvrPromptPolicy = Object.freeze({
  maxRetries: 3,
  maxTimeouts: 2,
  repeatDigit: "*",
  helpDigit: "#",
  assistedTransfer: Object.freeze({ enabled: false, digit: "0" }),
});

export interface IvrPromptEngineOptions {
  readonly treeVersion?: number;
  readonly maxRetries?: number;
  readonly maxTimeouts?: number;
  readonly assistedTransfer?: Readonly<{
    readonly enabled: boolean;
    readonly digit?: string;
  }>;
}

type SessionPatch = Readonly<{
  state?: IvrPromptState;
  locale?: IvrPromptLocale;
  retryCount?: number;
  timeoutCount?: number;
  status?: IvrSessionStatus;
  pendingEffect?: IvrPendingEffectKind | null;
  collected?: Readonly<Partial<Record<IvrCollectedField, string>>>;
}>;

const languageByDigit: Readonly<Record<string, IvrPromptLocale>> = Object.freeze({
  "1": "te",
  "2": "hi",
  "3": "en",
  "4": "kn",
  "5": "ta",
  "6": "mr",
  "7": "bn",
});

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validatePolicy(options: IvrPromptEngineOptions): IvrPromptPolicy {
  const maxRetries = options.maxRetries ?? defaultIvrPromptPolicy.maxRetries;
  const maxTimeouts = options.maxTimeouts ?? defaultIvrPromptPolicy.maxTimeouts;
  const transferDigit = options.assistedTransfer?.digit ?? defaultIvrPromptPolicy.assistedTransfer.digit;
  if (!isPositiveInteger(maxRetries) || !isPositiveInteger(maxTimeouts)) {
    throw new IvrPromptError("INVALID_POLICY", "IVR retry and timeout limits must be positive integers");
  }
  if (!/^\d$/u.test(transferDigit)) {
    throw new IvrPromptError("INVALID_POLICY", "The assisted-transfer input must be one keypad digit");
  }
  return Object.freeze({
    maxRetries,
    maxTimeouts,
    repeatDigit: "*",
    helpDigit: "#",
    assistedTransfer: Object.freeze({
      enabled: options.assistedTransfer?.enabled ?? false,
      digit: transferDigit,
    }),
  });
}

function updateSession(session: IvrPromptSession, patch: SessionPatch): IvrPromptSession {
  const pendingEffect = patch.pendingEffect === undefined ? session.pendingEffect : patch.pendingEffect ?? undefined;
  const collected = Object.freeze({ ...(patch.collected ?? session.collected) });
  return Object.freeze({
    promptTreeVersion: session.promptTreeVersion,
    promptVersion: session.promptVersion,
    state: patch.state ?? session.state,
    locale: patch.locale ?? session.locale,
    retryCount: patch.retryCount ?? session.retryCount,
    timeoutCount: patch.timeoutCount ?? session.timeoutCount,
    status: patch.status ?? session.status,
    ...(pendingEffect === undefined ? {} : { pendingEffect }),
    collected,
  });
}

function withCollected(
  session: IvrPromptSession,
  field: IvrCollectedField,
  value: string,
): Readonly<Partial<Record<IvrCollectedField, string>>> {
  return Object.freeze({ ...session.collected, [field]: value });
}

function cleanDigits(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length > 1 && trimmed.endsWith("#")) return trimmed.slice(0, -1);
  return trimmed;
}

function isOption(input: string, minimum: number, maximum: number): boolean {
  if (!/^\d{1,2}$/u.test(input)) return false;
  const value = Number(input);
  return value >= minimum && value <= maximum;
}

function isCalendarDate(input: string): boolean {
  if (!/^\d{8}$/u.test(input)) return false;
  const day = Number(input.slice(0, 2));
  const month = Number(input.slice(2, 4));
  const year = Number(input.slice(4, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isClockTime(input: string): boolean {
  if (!/^\d{4}$/u.test(input)) return false;
  return Number(input.slice(0, 2)) <= 23 && Number(input.slice(2, 4)) <= 59;
}

function safeDisplayValue(value: string, name: string): string {
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > 120) {
    throw new RangeError(`${name} must contain from 1 to 120 characters`);
  }
  return normalized;
}

/**
 * Pure prompt-tree coordinator. Provider callbacks persist the returned session and perform
 * each explicit effect through shared identity/booking services; this class never bypasses them.
 */
export class IvrPromptEngine {
  readonly treeVersion: number;
  readonly policy: IvrPromptPolicy;

  constructor(options: IvrPromptEngineOptions = {}) {
    this.treeVersion = options.treeVersion ?? IVR_PROMPT_TREE_VERSION;
    this.policy = validatePolicy(options);
    this.tree();
  }

  begin(locale: IvrPromptLocale = "en"): IvrPromptTurn {
    const session: IvrPromptSession = Object.freeze({
      promptTreeVersion: this.treeVersion,
      promptVersion: 0,
      state: "LANGUAGE",
      locale,
      retryCount: 0,
      timeoutCount: 0,
      status: "ACTIVE",
      collected: Object.freeze({}),
    });
    return this.emit(session);
  }

  renderCurrent(session: IvrPromptSession): IvrPromptTurn {
    this.assertActive(session);
    return this.emit(session);
  }

  handleDigits(session: IvrPromptSession, expectedPromptVersion: number, input: string): IvrPromptTurn {
    this.assertInputVersion(session, expectedPromptVersion);
    const raw = input.trim();

    if (raw === this.policy.repeatDigit) return this.emit(session);
    if (raw === this.policy.helpDigit) return this.emit(session, this.helpKey(), true);
    if (this.policy.assistedTransfer.enabled && raw === this.policy.assistedTransfer.digit) {
      return this.finish(session, "TRANSFERRED");
    }
    if (session.pendingEffect !== undefined) {
      throw new IvrPromptError("EFFECT_PENDING", "Complete the pending IVR operation before accepting more digits");
    }

    const digits = cleanDigits(raw);
    switch (session.state) {
      case "LANGUAGE": {
        const locale = languageByDigit[digits];
        return locale === undefined
          ? this.invalid(session)
          : this.advance(session, "VERIFICATION", { locale });
      }
      case "VERIFICATION":
        return /^\d{4,8}$/u.test(digits)
          ? this.effect(session, { kind: "VERIFY_CALLER", verificationCode: digits }, "ivr.verification.checking")
          : this.invalid(session);
      case "PURPOSE":
        if (digits === "1") return this.advance(session, "LOCATION_METHOD");
        if (digits === "2") return this.advance(session, "BOOKING_STATUS_REFERENCE");
        return this.invalid(session);
      case "LOCATION_METHOD":
        if (digits === "1") return this.advance(session, "SAVED_LOCATION");
        if (digits === "2") return this.advance(session, "MANUAL_STATE");
        if (digits === "3") return this.advance(session, "MANUAL_PIN");
        return this.invalid(session);
      case "SAVED_LOCATION":
        return isOption(digits, 1, 9)
          ? this.effect(
            updateSession(session, { collected: withCollected(session, "savedLocationSelection", digits) }),
            { kind: "SELECT_SAVED_LOCATION", selection: Number(digits) },
            "ivr.location.saved",
          )
          : this.invalid(session);
      case "MANUAL_STATE":
        return this.collectOption(session, digits, "manualStateSelection", "MANUAL_DISTRICT");
      case "MANUAL_DISTRICT":
        return this.collectOption(session, digits, "manualDistrictSelection", "MANUAL_MANDAL");
      case "MANUAL_MANDAL":
        return this.collectOption(session, digits, "manualMandalSelection", "MANUAL_VILLAGE");
      case "MANUAL_VILLAGE":
        return this.collectOption(session, digits, "manualVillageSelection", "SERVICE");
      case "MANUAL_PIN":
        return /^[1-9]\d{5}$/u.test(digits)
          ? this.advance(session, "SERVICE", { collected: withCollected(session, "postalCode", digits) })
          : this.invalid(session);
      case "SERVICE":
        return isOption(digits, 1, 9)
          ? this.advance(session, "DATE", { collected: withCollected(session, "serviceSelection", digits) })
          : this.invalid(session);
      case "DATE":
        return isCalendarDate(digits)
          ? this.advance(session, "TIME", { collected: withCollected(session, "serviceDate", digits) })
          : this.invalid(session);
      case "TIME":
        return isClockTime(digits)
          ? this.advance(session, "QUANTITY", { collected: withCollected(session, "serviceTime", digits) })
          : this.invalid(session);
      case "QUANTITY":
        return /^\d{1,4}$/u.test(digits) && Number(digits) > 0
          ? this.advance(session, "CONFIRMATION", { collected: withCollected(session, "quantity", String(Number(digits))) })
          : this.invalid(session);
      case "CONFIRMATION":
        if (digits === "1") return this.effect(session, { kind: "SUBMIT_BOOKING" }, "ivr.confirmation.submitting");
        if (digits === "2") return this.restartBooking(session);
        return this.invalid(session);
      case "BOOKING_STATUS_REFERENCE":
        return /^\d{6,12}$/u.test(digits)
          ? this.effect(
            updateSession(session, { collected: withCollected(session, "bookingReference", digits) }),
            { kind: "LOOK_UP_BOOKING_STATUS", bookingReference: digits },
            "ivr.status.checking",
          )
          : this.invalid(session);
      case "BOOKING_STATUS":
        if (digits === "1") return this.advance(session, "PURPOSE");
        if (digits === "2") return this.emit(session);
        return this.invalid(session);
      case "COMPLETED":
      case "TRANSFERRED":
      case "TERMINATED":
        return this.invalid(session);
    }
  }

  handleTimeout(session: IvrPromptSession, expectedPromptVersion: number): IvrPromptTurn {
    this.assertInputVersion(session, expectedPromptVersion);
    const timeoutCount = session.timeoutCount + 1;
    if (timeoutCount >= this.policy.maxTimeouts) return this.exhausted(session);
    return this.emit(updateSession(session, { timeoutCount }), "ivr.timeout", true);
  }

  resolveVerification(session: IvrPromptSession, verified: boolean): IvrPromptTurn {
    this.assertPending(session, "VERIFY_CALLER");
    const resolved = updateSession(session, { pendingEffect: null });
    return verified ? this.advance(resolved, "PURPOSE") : this.invalid(resolved);
  }

  resolveSavedLocation(session: IvrPromptSession, foundAndUsable: boolean): IvrPromptTurn {
    this.assertPending(session, "SELECT_SAVED_LOCATION");
    const resolved = updateSession(session, { pendingEffect: null });
    return foundAndUsable ? this.advance(resolved, "SERVICE") : this.invalid(resolved);
  }

  resolveBookingStatus(session: IvrPromptSession, localizedStatus: string | null): IvrPromptTurn {
    this.assertPending(session, "LOOK_UP_BOOKING_STATUS");
    const resolved = updateSession(session, { pendingEffect: null });
    if (localizedStatus === null) return this.invalid(resolved);
    return this.advance(resolved, "BOOKING_STATUS", {
      collected: withCollected(resolved, "bookingStatus", safeDisplayValue(localizedStatus, "Booking status")),
    });
  }

  resolveBookingSubmission(session: IvrPromptSession, bookingReference: string | null): IvrPromptTurn {
    this.assertPending(session, "SUBMIT_BOOKING");
    const resolved = updateSession(session, { pendingEffect: null });
    if (bookingReference === null) return this.invalid(resolved);
    return this.advance(resolved, "COMPLETED", {
      status: "COMPLETED",
      collected: withCollected(resolved, "bookingReference", safeDisplayValue(bookingReference, "Booking reference")),
    });
  }

  private tree(): IvrPromptTree {
    const tree = IVR_PROMPT_TREES[this.treeVersion];
    if (tree === undefined) {
      throw new IvrPromptError("UNKNOWN_TREE_VERSION", `IVR prompt tree version ${this.treeVersion} is not registered`);
    }
    return tree;
  }

  private node(session: IvrPromptSession): IvrPromptNode {
    const tree = IVR_PROMPT_TREES[session.promptTreeVersion];
    if (tree === undefined) {
      throw new IvrPromptError("UNKNOWN_TREE_VERSION", `IVR prompt tree version ${session.promptTreeVersion} is not registered`);
    }
    return tree.nodes[session.state];
  }

  private assertActive(session: IvrPromptSession): void {
    this.node(session);
    if (session.status !== "ACTIVE") {
      throw new IvrPromptError("SESSION_NOT_ACTIVE", `IVR session is ${session.status.toLowerCase()}`);
    }
  }

  private assertInputVersion(session: IvrPromptSession, expectedPromptVersion: number): void {
    this.assertActive(session);
    if (expectedPromptVersion !== session.promptVersion) {
      throw new IvrPromptError("STALE_PROMPT_VERSION", "Digits belong to an older or unknown IVR prompt");
    }
  }

  private assertPending(session: IvrPromptSession, effect: IvrPendingEffectKind): void {
    this.assertActive(session);
    if (session.pendingEffect !== effect) {
      throw new IvrPromptError("UNEXPECTED_EFFECT_RESOLUTION", `Expected pending IVR effect ${effect}`);
    }
  }

  private helpKey(): IvrPromptMessageKey {
    return this.policy.assistedTransfer.enabled ? "ivr.help.transfer" : "ivr.help";
  }

  private promptValues(session: IvrPromptSession): Readonly<Record<string, string>> {
    return Object.freeze({
      status: session.collected.bookingStatus ?? "unavailable",
      reference: session.collected.bookingReference ?? "unavailable",
    });
  }

  private emit(
    session: IvrPromptSession,
    prefixOrOverride?: IvrPromptMessageKey,
    appendCurrent = false,
    effect?: IvrPromptEffect,
  ): IvrPromptTurn {
    const next = updateSession(session, {});
    const versioned = Object.freeze({ ...next, promptVersion: next.promptVersion + 1 });
    const node = this.node(versioned);
    const selectedKey = prefixOrOverride ?? node.messageKey;
    const selected = renderIvrPromptMessage(versioned.locale, selectedKey, this.promptValues(versioned));
    const message = appendCurrent
      ? `${selected} ${renderIvrPromptMessage(versioned.locale, node.messageKey, this.promptValues(versioned))}`
      : selected;
    const prompt: IvrRenderedPrompt = Object.freeze({
      treeVersion: versioned.promptTreeVersion,
      promptVersion: versioned.promptVersion,
      state: versioned.state,
      step: node.step,
      locale: versioned.locale,
      messageKey: selectedKey,
      message,
      acceptsInput: node.acceptsInput,
    });
    return Object.freeze({ session: versioned, prompt, ...(effect === undefined ? {} : { effect }) });
  }

  private advance(session: IvrPromptSession, state: IvrPromptState, patch: SessionPatch = {}): IvrPromptTurn {
    return this.emit(updateSession(session, {
      ...patch,
      state,
      retryCount: 0,
      timeoutCount: 0,
      pendingEffect: null,
    }));
  }

  private effect(session: IvrPromptSession, effect: IvrPromptEffect, waitKey: IvrPromptMessageKey): IvrPromptTurn {
    return this.emit(updateSession(session, { pendingEffect: effect.kind }), waitKey, false, Object.freeze(effect));
  }

  private collectOption(
    session: IvrPromptSession,
    digits: string,
    field: IvrCollectedField,
    nextState: IvrPromptState,
  ): IvrPromptTurn {
    return isOption(digits, 1, 99)
      ? this.advance(session, nextState, { collected: withCollected(session, field, digits) })
      : this.invalid(session);
  }

  private invalid(session: IvrPromptSession): IvrPromptTurn {
    const retryCount = session.retryCount + 1;
    if (retryCount >= this.policy.maxRetries) return this.exhausted(session);
    return this.emit(updateSession(session, { retryCount }), "ivr.invalid", true);
  }

  private exhausted(session: IvrPromptSession): IvrPromptTurn {
    return this.policy.assistedTransfer.enabled
      ? this.finish(session, "TRANSFERRED")
      : this.finish(session, "TERMINATED");
  }

  private finish(session: IvrPromptSession, status: "TRANSFERRED" | "TERMINATED"): IvrPromptTurn {
    return this.emit(updateSession(session, {
      state: status,
      status,
      pendingEffect: null,
    }));
  }

  private restartBooking(session: IvrPromptSession): IvrPromptTurn {
    const retained: Partial<Record<IvrCollectedField, string>> = {};
    return this.advance(session, "PURPOSE", { collected: Object.freeze(retained) });
  }
}
