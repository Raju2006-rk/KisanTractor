import type {
  ActiveWorkInterval,
  AuthPrincipal,
  BillableUnit,
  FinalBillRoundingTrace,
  PricingMethod,
  RecordedWorkEvent,
  WorkAction,
  WorkState,
} from "@kisantractor/domain";
import type { AuditActorChannel } from "@kisantractor/database";
import type { BookingStatus } from "../booking/booking.contracts.js";

export interface JobRequestContext {
  readonly correlationId: string;
  readonly actorChannel: AuditActorChannel;
}

export interface JobActionCommand {
  readonly bookingId: string;
  readonly idempotencyKey: string;
  readonly deviceObservedAt?: Date;
}

export interface CompleteJobCommand extends JobActionCommand {
  /** Required for per-acre/per-trip agreements and omitted for hourly agreements. */
  readonly completedQuantity?: number | string;
}

export interface CorrectWorkEventCommand {
  readonly bookingId: string;
  readonly eventId: string;
  readonly correctedEffectiveAt: Date;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface CorrectWorkMeasurementCommand {
  readonly bookingId: string;
  readonly measurementId: string;
  readonly correctedQuantity: number | string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface WorkEventProjection extends RecordedWorkEvent {
  readonly bookingId: string;
  /** The recording Owner's account; omitted from Farmer views. */
  readonly actorId?: string;
  readonly actorChannel: AuditActorChannel;
  readonly deviceObservedAt?: Date;
  readonly reason?: string;
}

export type WorkMeasurementUnit = "ACRE" | "TRIP";

export interface WorkMeasurementProjection {
  readonly id: string;
  readonly bookingId: string;
  readonly method: "PER_ACRE" | "PER_TRIP";
  readonly quantity: string;
  readonly unit: WorkMeasurementUnit;
  /** The submitting Owner's account; omitted from Farmer views. */
  readonly submittedByUserId?: string;
  readonly correctionOfId?: string;
  readonly reason?: string;
  readonly createdAt: Date;
}

export type InvoiceStatus = "ISSUED" | "DISPUTED" | "SETTLED" | "VOID";

/** An append-only invoice version linked to the booking agreement it was calculated from. */
export interface InvoiceProjection {
  readonly id: string;
  readonly bookingId: string;
  readonly invoiceVersion: number;
  readonly supersedesInvoiceId?: string;
  readonly status: InvoiceStatus;
  readonly agreementId: string;
  readonly agreementVersion: number;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly currency: "INR";
  readonly billableQuantity: string;
  readonly billableUnit: BillableUnit;
  readonly subtotalPaise: number;
  readonly adjustmentsPaise: number;
  readonly totalPaise: number;
  readonly evidenceReferences: readonly string[];
  readonly formula: string;
  readonly roundingTrace: FinalBillRoundingTrace;
  readonly createdAt: Date;
}

export interface WorkSessionProjection {
  readonly bookingId: string;
  readonly bookingStatus: BookingStatus;
  readonly bookingVersion: number;
  readonly pricingMethod: PricingMethod;
  readonly state: WorkState;
  readonly validNextActions: readonly WorkAction[];
  readonly events: readonly WorkEventProjection[];
  readonly measurements: readonly WorkMeasurementProjection[];
  readonly activeIntervals: readonly ActiveWorkInterval[];
  readonly activeMilliseconds: number;
  readonly activeMinutes: number;
  readonly openStartedAt?: Date;
  /** Current (highest-version) final bill, present once work completion has been billed. */
  readonly invoice?: InvoiceProjection;
}

export interface ValidatedJobAction {
  readonly bookingId: string;
  readonly action: WorkAction;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly receivedAt: Date;
  readonly deviceObservedAt?: Date;
  readonly completedQuantity?: string;
}

export interface ValidatedWorkEventCorrection {
  readonly bookingId: string;
  readonly eventId: string;
  readonly correctedEffectiveAt: Date;
  readonly reason: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly receivedAt: Date;
}

export interface ValidatedWorkMeasurementCorrection {
  readonly bookingId: string;
  readonly measurementId: string;
  readonly correctedQuantity: string;
  readonly reason: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly receivedAt: Date;
}

/** The authenticated relationship a viewer must hold with the booking to read its work record. */
export type JobViewerRole = "OWNER" | "FARMER";

export interface WorkSessionQuery {
  readonly bookingId: string;
  readonly viewerId: string;
  readonly viewerRole: JobViewerRole;
}

export interface JobStore {
  /** Read-only: returns the work record only to the assigned Owner or the booking Farmer. */
  loadWorkSession(query: WorkSessionQuery, context: JobRequestContext): Promise<WorkSessionProjection>;
  recordAction(input: ValidatedJobAction, context: JobRequestContext): Promise<WorkSessionProjection>;
  correctWorkEvent(input: ValidatedWorkEventCorrection, context: JobRequestContext): Promise<WorkSessionProjection>;
  correctWorkMeasurement(input: ValidatedWorkMeasurementCorrection, context: JobRequestContext): Promise<WorkSessionProjection>;
}

export interface JobSessionAuthenticator {
  authenticateAccessCredential(accessCredential: string): Promise<AuthPrincipal>;
}
