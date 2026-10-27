export const workActions = ["START", "PAUSE", "RESUME", "COMPLETE"] as const;
export type WorkAction = (typeof workActions)[number];
export type WorkEventType = WorkAction | "CORRECTION";
export type WorkState = "NOT_STARTED" | "ACTIVE" | "PAUSED" | "COMPLETED";

export interface RecordedWorkEvent {
  readonly id: string;
  readonly eventType: WorkEventType;
  /** Authoritative server time, or the corrected authoritative time for a correction. */
  readonly effectiveAt: Date;
  readonly receivedAt: Date;
  readonly correctionOfId?: string;
}

export interface EffectiveWorkEvent {
  readonly id: string;
  readonly eventType: WorkAction;
  readonly effectiveAt: Date;
  readonly receivedAt: Date;
  readonly correctedById?: string;
}

export interface WorkSequenceEvaluation {
  readonly state: WorkState;
  readonly validNextActions: readonly WorkAction[];
  readonly events: readonly EffectiveWorkEvent[];
}

export interface ActiveWorkInterval {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly closedBy: "PAUSE" | "COMPLETE";
  readonly durationMilliseconds: number;
}

export interface ActiveIntervalFold extends WorkSequenceEvaluation {
  readonly intervals: readonly ActiveWorkInterval[];
  readonly activeMilliseconds: number;
  readonly activeMinutes: number;
  readonly openStartedAt?: Date;
}

const nextActionsByState = Object.freeze({
  NOT_STARTED: Object.freeze(["START"] as const),
  ACTIVE: Object.freeze(["PAUSE", "COMPLETE"] as const),
  PAUSED: Object.freeze(["RESUME"] as const),
  COMPLETED: Object.freeze([] as const),
}) satisfies Readonly<Record<WorkState, readonly WorkAction[]>>;

export class WorkSequenceError extends Error {
  readonly code = "WORK_EVENT_OUT_OF_SEQUENCE";

  constructor(
    message: string,
    readonly currentState: WorkState,
    readonly validNextActions: readonly WorkAction[],
    readonly eventId?: string,
  ) {
    super(message);
    this.name = "WorkSequenceError";
  }
}

const assertValidDate = (value: Date, field: string): void => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid instant`);
  }
};

const orderedEvents = (events: readonly RecordedWorkEvent[]): readonly RecordedWorkEvent[] =>
  [...events].sort((left, right) =>
    left.receivedAt.getTime() - right.receivedAt.getTime() || left.id.localeCompare(right.id));

/** Applies append-only timestamp corrections without removing or changing an original event. */
export function resolveWorkEventCorrections(events: readonly RecordedWorkEvent[]): readonly EffectiveWorkEvent[] {
  const ordered = orderedEvents(events);
  const originals = new Map<string, EffectiveWorkEvent>();
  const corrections = new Map<string, RecordedWorkEvent>();

  for (const event of ordered) {
    assertValidDate(event.effectiveAt, "effectiveAt");
    assertValidDate(event.receivedAt, "receivedAt");
    if (event.eventType === "CORRECTION") {
      if (event.correctionOfId === undefined || event.correctionOfId.length === 0) {
        throw new TypeError("A work-event correction must reference an original event");
      }
      const target = originals.get(event.correctionOfId);
      if (target === undefined) {
        throw new TypeError("A work-event correction must reference an earlier original event");
      }
      corrections.set(event.correctionOfId, event);
      continue;
    }
    if (event.correctionOfId !== undefined) {
      throw new TypeError("Only correction events may reference another event");
    }
    if (originals.has(event.id)) throw new TypeError(`Duplicate work event id: ${event.id}`);
    originals.set(event.id, Object.freeze({
      id: event.id,
      eventType: event.eventType,
      effectiveAt: new Date(event.effectiveAt),
      receivedAt: new Date(event.receivedAt),
    }));
  }

  return Object.freeze([...originals.values()].map((event) => {
    const correction = corrections.get(event.id);
    return correction === undefined ? event : Object.freeze({
      ...event,
      effectiveAt: new Date(correction.effectiveAt),
      correctedById: correction.id,
    });
  }));
}

/** Validates command order and reports the only actions accepted from the resulting state. */
export function evaluateWorkSequence(events: readonly RecordedWorkEvent[]): WorkSequenceEvaluation {
  const effectiveEvents = resolveWorkEventCorrections(events);
  let state: WorkState = "NOT_STARTED";
  let previousEffectiveAt: Date | undefined;

  for (const event of effectiveEvents) {
    if (previousEffectiveAt !== undefined && event.effectiveAt < previousEffectiveAt) {
      throw new WorkSequenceError(
        "Work event time is earlier than the preceding event",
        state,
        nextActionsByState[state],
        event.id,
      );
    }
    const validNextActions: readonly WorkAction[] = nextActionsByState[state];
    if (!validNextActions.includes(event.eventType)) {
      throw new WorkSequenceError(
        `Cannot ${event.eventType.toLowerCase()} work while work is ${state.toLowerCase().replace("_", " ")}`,
        state,
        validNextActions,
        event.id,
      );
    }
    state = event.eventType === "START" || event.eventType === "RESUME"
      ? "ACTIVE"
      : event.eventType === "PAUSE" ? "PAUSED" : "COMPLETED";
    previousEffectiveAt = event.effectiveAt;
  }

  return Object.freeze({ state, validNextActions: nextActionsByState[state], events: effectiveEvents });
}

/** Folds closed active intervals. Paused time and any currently open interval are excluded. */
export function foldActiveWorkIntervals(events: readonly RecordedWorkEvent[]): ActiveIntervalFold {
  const evaluation = evaluateWorkSequence(events);
  const intervals: ActiveWorkInterval[] = [];
  let activeStartedAt: Date | undefined;
  let activeMilliseconds = 0;

  for (const event of evaluation.events) {
    if (event.eventType === "START" || event.eventType === "RESUME") {
      activeStartedAt = event.effectiveAt;
      continue;
    }
    if ((event.eventType === "PAUSE" || event.eventType === "COMPLETE") && activeStartedAt !== undefined) {
      const durationMilliseconds = event.effectiveAt.getTime() - activeStartedAt.getTime();
      const interval = Object.freeze({
        startedAt: new Date(activeStartedAt),
        endedAt: new Date(event.effectiveAt),
        closedBy: event.eventType,
        durationMilliseconds,
      });
      intervals.push(interval);
      activeMilliseconds += durationMilliseconds;
      activeStartedAt = undefined;
    }
  }

  return Object.freeze({
    ...evaluation,
    intervals: Object.freeze(intervals),
    activeMilliseconds,
    activeMinutes: activeMilliseconds / 60_000,
    ...(activeStartedAt === undefined ? {} : { openStartedAt: new Date(activeStartedAt) }),
  });
}

export function validNextWorkActions(events: readonly RecordedWorkEvent[]): readonly WorkAction[] {
  return evaluateWorkSequence(events).validNextActions;
}
