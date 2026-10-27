export const IVR_PROMPT_TREE_VERSION = 1 as const;

export const ivrPromptLocales = ["en", "hi", "te", "kn", "ta", "mr", "bn"] as const;
export type IvrPromptLocale = (typeof ivrPromptLocales)[number];

export const ivrPromptStates = [
  "LANGUAGE",
  "VERIFICATION",
  "PURPOSE",
  "LOCATION_METHOD",
  "SAVED_LOCATION",
  "MANUAL_STATE",
  "MANUAL_DISTRICT",
  "MANUAL_MANDAL",
  "MANUAL_VILLAGE",
  "MANUAL_PIN",
  "SERVICE",
  "DATE",
  "TIME",
  "QUANTITY",
  "CONFIRMATION",
  "BOOKING_STATUS_REFERENCE",
  "BOOKING_STATUS",
  "COMPLETED",
  "TRANSFERRED",
  "TERMINATED",
] as const;
export type IvrPromptState = (typeof ivrPromptStates)[number];

export type IvrPromptStep =
  | "LANGUAGE"
  | "VERIFICATION"
  | "LOCATION"
  | "SERVICE"
  | "DATE_TIME"
  | "QUANTITY"
  | "CONFIRMATION"
  | "BOOKING_STATUS"
  | "NONE";

export type IvrSessionStatus = "ACTIVE" | "COMPLETED" | "TRANSFERRED" | "TERMINATED";
export type IvrPendingEffectKind =
  | "VERIFY_CALLER"
  | "SELECT_SAVED_LOCATION"
  | "LOOK_UP_BOOKING_STATUS"
  | "SUBMIT_BOOKING";

export type IvrCollectedField =
  | "verificationCode"
  | "savedLocationSelection"
  | "manualStateSelection"
  | "manualDistrictSelection"
  | "manualMandalSelection"
  | "manualVillageSelection"
  | "postalCode"
  | "serviceSelection"
  | "serviceDate"
  | "serviceTime"
  | "quantity"
  | "bookingReference"
  | "bookingStatus";

export interface IvrPromptSession {
  readonly promptTreeVersion: number;
  readonly promptVersion: number;
  readonly state: IvrPromptState;
  readonly locale: IvrPromptLocale;
  readonly retryCount: number;
  readonly timeoutCount: number;
  readonly status: IvrSessionStatus;
  readonly pendingEffect?: IvrPendingEffectKind;
  readonly collected: Readonly<Partial<Record<IvrCollectedField, string>>>;
}

export type IvrPromptMessageKey =
  | "ivr.language"
  | "ivr.verification"
  | "ivr.verification.checking"
  | "ivr.purpose"
  | "ivr.location.method"
  | "ivr.location.saved"
  | "ivr.location.state"
  | "ivr.location.district"
  | "ivr.location.mandal"
  | "ivr.location.village"
  | "ivr.location.pin"
  | "ivr.service"
  | "ivr.date"
  | "ivr.time"
  | "ivr.quantity"
  | "ivr.confirmation"
  | "ivr.confirmation.submitting"
  | "ivr.status.reference"
  | "ivr.status.checking"
  | "ivr.status.result"
  | "ivr.completed"
  | "ivr.invalid"
  | "ivr.help"
  | "ivr.help.transfer"
  | "ivr.timeout"
  | "ivr.transfer"
  | "ivr.terminated";

export interface IvrPromptNode {
  readonly state: IvrPromptState;
  readonly step: IvrPromptStep;
  readonly messageKey: IvrPromptMessageKey;
  readonly acceptsInput: boolean;
}

export interface IvrPromptTree {
  readonly version: number;
  readonly nodes: Readonly<Record<IvrPromptState, IvrPromptNode>>;
}

export interface IvrRenderedPrompt {
  readonly treeVersion: number;
  readonly promptVersion: number;
  readonly state: IvrPromptState;
  readonly step: IvrPromptStep;
  readonly locale: IvrPromptLocale;
  readonly messageKey: IvrPromptMessageKey;
  readonly message: string;
  readonly acceptsInput: boolean;
}

export type IvrPromptEffect =
  | Readonly<{ kind: "VERIFY_CALLER"; verificationCode: string }>
  | Readonly<{ kind: "SELECT_SAVED_LOCATION"; selection: number }>
  | Readonly<{ kind: "LOOK_UP_BOOKING_STATUS"; bookingReference: string }>
  | Readonly<{ kind: "SUBMIT_BOOKING" }>;

export interface IvrPromptTurn {
  readonly session: IvrPromptSession;
  readonly prompt: IvrRenderedPrompt;
  readonly effect?: IvrPromptEffect;
}

export interface IvrPromptPolicy {
  readonly maxRetries: number;
  readonly maxTimeouts: number;
  readonly repeatDigit: "*";
  readonly helpDigit: "#";
  readonly assistedTransfer: Readonly<{
    readonly enabled: boolean;
    readonly digit: string;
  }>;
}

export class IvrPromptError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_TREE_VERSION"
      | "STALE_PROMPT_VERSION"
      | "SESSION_NOT_ACTIVE"
      | "EFFECT_PENDING"
      | "UNEXPECTED_EFFECT_RESOLUTION"
      | "INVALID_POLICY",
    message: string,
  ) {
    super(message);
    this.name = "IvrPromptError";
  }
}
