import type { AuthPrincipal } from "@kisantractor/domain";
import type {
  PrivateDownloadGrant,
  PrivateObjectEncryptionAlgorithm,
  PrivateUploadGrant,
} from "@kisantractor/providers";

import type { CatalogRequestContext } from "./catalog.contracts.js";

export const documentMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type DocumentMimeType = (typeof documentMimeTypes)[number];

export type DocumentScanStatus =
  | "PENDING_UPLOAD"
  | "PENDING_SCAN"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED";

export interface DocumentUploadRequest {
  readonly tractorId?: string;
  readonly equipmentId?: string;
  readonly documentKind: string;
  readonly fileName: string;
  readonly declaredMimeType: string;
  readonly sizeBytes: number;
  readonly expiresAt?: Date;
}

export interface DocumentMetadataProjection {
  readonly id: string;
  readonly ownerId: string;
  readonly tractorId?: string;
  readonly equipmentId?: string;
  readonly documentKind: string;
  readonly fileName: string;
  readonly declaredMimeType: DocumentMimeType;
  readonly detectedMimeType?: DocumentMimeType;
  readonly declaredSizeBytes: number;
  readonly uploadedSizeBytes?: number;
  readonly contentDigest?: string;
  readonly encryptionAlgorithm?: PrivateObjectEncryptionAlgorithm;
  readonly scanStatus: DocumentScanStatus;
  readonly rejectionCode?: string;
  readonly uploadGrantExpiresAt?: Date;
  readonly scanCompletedAt?: Date;
  readonly acceptedAt?: Date;
  readonly expiresAt?: Date;
  readonly version: number;
}

export interface PrivateDocumentUploadGrant {
  readonly document: DocumentMetadataProjection;
  readonly grant: PrivateUploadGrant;
  readonly capabilityState: "SANDBOX" | "LIVE";
}

export interface AuthorizedDocumentDownloadGrant {
  readonly document: DocumentMetadataProjection;
  readonly grant: PrivateDownloadGrant;
  readonly capabilityState: "SANDBOX" | "LIVE";
}

export interface StoredDocument extends DocumentMetadataProjection {
  readonly objectKeyCiphertext: Uint8Array;
}

export interface PendingDocumentInput {
  readonly tractorId?: string;
  readonly equipmentId?: string;
  readonly documentKind: string;
  readonly fileName: string;
  readonly declaredMimeType: DocumentMimeType;
  readonly declaredSizeBytes: number;
  readonly objectKeyCiphertext: Uint8Array;
  readonly uploadGrantExpiresAt: Date;
  readonly expiresAt?: Date;
}

export interface InspectedDocumentInput {
  readonly detectedMimeType: DocumentMimeType;
  readonly uploadedSizeBytes: number;
  readonly contentDigest: string;
  readonly encryptionAlgorithm: PrivateObjectEncryptionAlgorithm;
}

export interface DocumentStore {
  createPending(
    ownerId: string,
    input: PendingDocumentInput,
    context: CatalogRequestContext,
  ): Promise<StoredDocument | undefined>;
  findById(documentId: string): Promise<StoredDocument | undefined>;
  /** Every document the Owner holds, newest first. */
  listByOwner(ownerId: string): Promise<readonly StoredDocument[]>;
  markPendingScan(
    documentId: string,
    ownerId: string,
    actorId: string,
    input: InspectedDocumentInput,
    context: CatalogRequestContext,
  ): Promise<StoredDocument | undefined>;
  markAccepted(
    documentId: string,
    ownerId: string,
    actorId: string,
    context: CatalogRequestContext,
  ): Promise<StoredDocument | undefined>;
  markRejected(
    documentId: string,
    ownerId: string,
    actorId: string,
    rejectionCode: string,
    context: CatalogRequestContext,
  ): Promise<StoredDocument | undefined>;
  recordDownloadGrant(
    documentId: string,
    actorId: string,
    context: CatalogRequestContext,
  ): Promise<void>;
}

export type DocumentMalwareScanResult = "CLEAN" | "INFECTED" | "UNAVAILABLE";

export interface DocumentMalwareScanner {
  scan(input: {
    readonly objectKey: string;
    readonly contentDigest: string;
  }): Promise<DocumentMalwareScanResult>;
}

export interface DocumentSessionAuthenticator {
  authenticateAccessCredential(accessCredential: string): Promise<AuthPrincipal>;
}
