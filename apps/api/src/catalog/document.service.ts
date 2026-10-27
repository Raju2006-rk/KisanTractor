import { randomUUID } from "node:crypto";

import type { AuthPrincipal } from "@kisantractor/domain";
import {
  CapabilityRegistry,
  type PrivateObjectEncryptionAlgorithm,
  type PrivateObjectInspection,
  type PrivateObjectStorageProvider,
  type PrivateUploadGrant,
} from "@kisantractor/providers";

import { AuthorizationService } from "../authorization/index.js";
import { CatalogCrypto } from "./catalog-crypto.js";
import type { CatalogRequestContext, CatalogSecrets } from "./catalog.contracts.js";
import {
  documentMimeTypes,
  type AuthorizedDocumentDownloadGrant,
  type DocumentMalwareScanner,
  type DocumentMetadataProjection,
  type DocumentMimeType,
  type DocumentStore,
  type DocumentUploadRequest,
  type PrivateDocumentUploadGrant,
  type StoredDocument,
} from "./document.contracts.js";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const UPLOAD_GRANT_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_GRANT_TTL_MS = 2 * 60 * 1000;
const SIGNATURE_BYTE_LIMIT = 16;
const REQUIRED_ENCRYPTION: PrivateObjectEncryptionAlgorithm = "AES256";
const MIME_SET = new Set<string>(documentMimeTypes);
const EXTENSION_MIME = Object.freeze<Record<string, DocumentMimeType>>({
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

export class DocumentValidationError extends Error {
  readonly code = "DOCUMENT_VALIDATION_FAILED";

  constructor(readonly reasonCode: string, message: string) {
    super(message);
    this.name = "DocumentValidationError";
  }
}

export class DocumentStateError extends Error {
  readonly code = "DOCUMENT_STATE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "DocumentStateError";
  }
}

export class DocumentScanUnavailableError extends Error {
  readonly code = "DOCUMENT_SCAN_UNAVAILABLE";
  readonly retryable = true;

  constructor() {
    super("The document security scan is temporarily unavailable; retry safely");
    this.name = "DocumentScanUnavailableError";
  }
}

export class InvalidObjectStorageGrantError extends Error {
  readonly code = "INVALID_OBJECT_STORAGE_GRANT";

  constructor() {
    super("The object storage provider returned an invalid private grant");
    this.name = "InvalidObjectStorageGrantError";
  }
}

interface ValidatedUploadRequest {
  readonly tractorId?: string;
  readonly equipmentId?: string;
  readonly documentKind: string;
  readonly fileName: string;
  readonly declaredMimeType: DocumentMimeType;
  readonly sizeBytes: number;
  readonly expiresAt?: Date;
}

export class PrivateDocumentService {
  readonly #crypto: CatalogCrypto;

  constructor(
    private readonly store: DocumentStore,
    private readonly authorization: AuthorizationService,
    private readonly capabilities: CapabilityRegistry,
    secrets: CatalogSecrets,
    private readonly scanner: DocumentMalwareScanner,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#crypto = new CatalogCrypto(secrets);
  }

  async issueUploadGrant(
    principal: AuthPrincipal,
    input: DocumentUploadRequest,
    context: CatalogRequestContext,
  ): Promise<PrivateDocumentUploadGrant> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    const validated = this.#validateUploadRequest(input);
    const provider = this.capabilities.requireConfigured<PrivateObjectStorageProvider>(
      "OBJECT_STORAGE",
    );
    const capabilityState = this.#operationalCapabilityState();
    const issuedAt = this.now();
    const grantExpiresAt = new Date(issuedAt.getTime() + UPLOAD_GRANT_TTL_MS);
    const objectKey = `private/documents/${randomUUID()}`;
    const stored = await this.store.createPending(
      principal.userId,
      {
        ...(validated.tractorId === undefined ? {} : { tractorId: validated.tractorId }),
        ...(validated.equipmentId === undefined ? {} : { equipmentId: validated.equipmentId }),
        documentKind: validated.documentKind,
        fileName: validated.fileName,
        declaredMimeType: validated.declaredMimeType,
        declaredSizeBytes: validated.sizeBytes,
        objectKeyCiphertext: this.#crypto.encrypt(objectKey, "document-object-key"),
        uploadGrantExpiresAt: grantExpiresAt,
        ...(validated.expiresAt === undefined ? {} : { expiresAt: validated.expiresAt }),
      },
      context,
    );
    if (stored === undefined) {
      throw new DocumentValidationError(
        "INVALID_RESOURCE_SCOPE",
        "The Tractor or Equipment is unavailable for this Owner",
      );
    }

    let grant: PrivateUploadGrant;
    try {
      grant = await provider.issueUploadGrant({
        objectKey,
        contentType: validated.declaredMimeType,
        contentLength: validated.sizeBytes,
        expiresAt: grantExpiresAt,
        encryptionAlgorithm: REQUIRED_ENCRYPTION,
      });
      this.#assertUploadGrant(grant, grantExpiresAt, validated.declaredMimeType);
    } catch (error) {
      await this.store.markRejected(
        stored.id,
        stored.ownerId,
        principal.userId,
        "INVALID_PROVIDER_GRANT",
        context,
      );
      if (error instanceof InvalidObjectStorageGrantError) throw error;
      throw new InvalidObjectStorageGrantError();
    }

    return Object.freeze({
      document: this.#project(stored),
      grant,
      capabilityState,
    });
  }

  /** The calling Owner's document metadata, newest first; other Owners' documents never appear. */
  async listOwnerDocuments(principal: AuthPrincipal): Promise<readonly DocumentMetadataProjection[]> {
    this.#assertOwner(principal);
    const documents = await this.store.listByOwner(principal.userId);
    return Object.freeze(documents.map((document) => this.#project(document)));
  }

  async completeUpload(
    principal: AuthPrincipal,
    documentId: string,
    context: CatalogRequestContext,
  ): Promise<DocumentMetadataProjection> {
    this.#assertContext(context);
    return this.authorization.commandPrivateDocument(principal, documentId, async (resource) => {
      let document = await this.#requireStored(documentId);
      if (document.scanStatus === "ACCEPTED") return this.#project(document);
      if (document.scanStatus === "REJECTED" || document.scanStatus === "EXPIRED") {
        throw new DocumentStateError("This document upload can no longer be completed");
      }

      const provider = this.capabilities.requireConfigured<PrivateObjectStorageProvider>(
        "OBJECT_STORAGE",
      );
      const objectKey = this.#decryptObjectKey(document);

      if (document.scanStatus === "PENDING_UPLOAD") {
        const inspection = await provider.inspectObject(objectKey, SIGNATURE_BYTE_LIMIT);
        const rejectionCode = this.#inspectionRejection(document, inspection);
        if (rejectionCode !== undefined) {
          const rejected = await this.store.markRejected(
            document.id,
            resource.ownerId,
            principal.userId,
            rejectionCode,
            context,
          );
          if (rejected === undefined) throw new DocumentStateError("Document state changed");
          return this.#project(rejected);
        }
        const detectedMimeType = detectDocumentMime(inspection.signatureBytes);
        if (detectedMimeType === undefined || inspection.encryptionAlgorithm === undefined) {
          throw new Error("Validated inspection is missing required metadata");
        }
        const pendingScan = await this.store.markPendingScan(
          document.id,
          resource.ownerId,
          principal.userId,
          {
            detectedMimeType,
            uploadedSizeBytes: inspection.contentLength,
            contentDigest: inspection.contentDigest,
            encryptionAlgorithm: inspection.encryptionAlgorithm,
          },
          context,
        );
        if (pendingScan === undefined) throw new DocumentStateError("Document state changed");
        document = pendingScan;
      }

      if (document.contentDigest === undefined) {
        throw new DocumentStateError("Document inspection is incomplete");
      }
      const scanResult = await this.scanner.scan({
        objectKey,
        contentDigest: document.contentDigest,
      });
      if (scanResult === "UNAVAILABLE") throw new DocumentScanUnavailableError();
      if (scanResult === "INFECTED") {
        const rejected = await this.store.markRejected(
          document.id,
          resource.ownerId,
          principal.userId,
          "MALWARE_DETECTED",
          context,
        );
        if (rejected === undefined) throw new DocumentStateError("Document state changed");
        return this.#project(rejected);
      }

      const accepted = await this.store.markAccepted(
        document.id,
        resource.ownerId,
        principal.userId,
        context,
      );
      if (accepted === undefined) throw new DocumentStateError("Document state changed");
      return this.#project(accepted);
    });
  }

  async issueDownloadGrant(
    principal: AuthPrincipal,
    documentId: string,
    context: CatalogRequestContext,
  ): Promise<AuthorizedDocumentDownloadGrant> {
    this.#assertContext(context);
    return this.authorization.queryPrivateDocument(principal, documentId, async () => {
      const document = await this.#requireStored(documentId);
      if (document.scanStatus !== "ACCEPTED") {
        throw new DocumentStateError("Only accepted documents can be downloaded");
      }
      if (document.expiresAt !== undefined && document.expiresAt.getTime() <= this.now().getTime()) {
        throw new DocumentStateError("This document has expired");
      }
      if (document.encryptionAlgorithm === undefined) {
        throw new DocumentStateError("Document encryption metadata is missing");
      }

      const provider = this.capabilities.requireConfigured<PrivateObjectStorageProvider>(
        "OBJECT_STORAGE",
      );
      const capabilityState = this.#operationalCapabilityState();
      const requestedExpiry = new Date(this.now().getTime() + DOWNLOAD_GRANT_TTL_MS);
      const grant = await provider.issueDownloadGrant({
        objectKey: this.#decryptObjectKey(document),
        expiresAt: requestedExpiry,
        downloadFileName: document.fileName,
      });
      this.#assertGrantUrlAndExpiry(grant.url, grant.expiresAt, requestedExpiry);
      await this.store.recordDownloadGrant(document.id, principal.userId, context);
      return Object.freeze({
        document: this.#project(document),
        grant,
        capabilityState,
      });
    });
  }

  #inspectionRejection(
    document: StoredDocument,
    inspection: PrivateObjectInspection,
  ): string | undefined {
    if (!Number.isSafeInteger(inspection.contentLength) || inspection.contentLength <= 0) {
      return "INVALID_SIZE";
    }
    if (
      inspection.contentLength > MAX_DOCUMENT_BYTES ||
      inspection.contentLength !== document.declaredSizeBytes
    ) {
      return "SIZE_MISMATCH";
    }
    const storedMime = normalizeMediaType(inspection.contentType);
    const detectedMime = detectDocumentMime(inspection.signatureBytes);
    if (storedMime !== document.declaredMimeType || detectedMime !== document.declaredMimeType) {
      return "MIME_SIGNATURE_MISMATCH";
    }
    if (!/^(?:sha256:)?[a-f0-9]{64}$/iu.test(inspection.contentDigest)) {
      return "INVALID_CONTENT_DIGEST";
    }
    if (inspection.encryptionAlgorithm !== REQUIRED_ENCRYPTION) {
      return "OBJECT_NOT_ENCRYPTED";
    }
    return undefined;
  }

  #validateUploadRequest(input: DocumentUploadRequest): ValidatedUploadRequest {
    const documentKind = input.documentKind.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/u.test(documentKind)) {
      throw new DocumentValidationError("INVALID_DOCUMENT_KIND", "Invalid document kind");
    }
    const fileName = sanitizeFileName(input.fileName);
    const declaredMimeType = normalizeMediaType(input.declaredMimeType);
    if (!MIME_SET.has(declaredMimeType)) {
      throw new DocumentValidationError("UNSUPPORTED_MIME_TYPE", "Unsupported document MIME type");
    }
    const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    if (EXTENSION_MIME[extension] !== declaredMimeType) {
      throw new DocumentValidationError(
        "EXTENSION_MIME_MISMATCH",
        "File extension does not match the declared MIME type",
      );
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_DOCUMENT_BYTES) {
      throw new DocumentValidationError(
        "INVALID_SIZE",
        `Document size must be between 1 and ${MAX_DOCUMENT_BYTES} bytes`,
      );
    }
    if (input.tractorId === undefined && input.equipmentId === undefined) {
      throw new DocumentValidationError(
        "RESOURCE_SCOPE_REQUIRED",
        "A Tractor or Equipment scope is required",
      );
    }
    if (input.expiresAt !== undefined && input.expiresAt.getTime() <= this.now().getTime()) {
      throw new DocumentValidationError("INVALID_EXPIRY", "Document expiry must be in the future");
    }
    return Object.freeze({
      ...(input.tractorId === undefined ? {} : { tractorId: requireIdentifier(input.tractorId) }),
      ...(input.equipmentId === undefined ? {} : { equipmentId: requireIdentifier(input.equipmentId) }),
      documentKind,
      fileName,
      declaredMimeType: declaredMimeType as DocumentMimeType,
      sizeBytes: input.sizeBytes,
      ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }),
    });
  }

  #assertUploadGrant(grant: PrivateUploadGrant, requestedExpiry: Date, mimeType: string): void {
    this.#assertGrantUrlAndExpiry(grant.url, grant.expiresAt, requestedExpiry);
    if (grant.method !== "PUT" || grant.encryptionAlgorithm !== REQUIRED_ENCRYPTION) {
      throw new InvalidObjectStorageGrantError();
    }
    const headers = Object.fromEntries(
      Object.entries(grant.requiredHeaders).map(([name, value]) => [name.toLowerCase(), value]),
    );
    if (normalizeMediaType(headers["content-type"] ?? "") !== mimeType) {
      throw new InvalidObjectStorageGrantError();
    }
  }

  #assertGrantUrlAndExpiry(url: string, expiresAt: Date, requestedExpiry: Date): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new InvalidObjectStorageGrantError();
    }
    const now = this.now().getTime();
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= now ||
      expiresAt.getTime() > requestedExpiry.getTime()
    ) {
      throw new InvalidObjectStorageGrantError();
    }
  }

  async #requireStored(documentId: string): Promise<StoredDocument> {
    const document = await this.store.findById(documentId);
    if (document === undefined) throw new DocumentStateError("Document metadata is unavailable");
    return document;
  }

  #decryptObjectKey(document: StoredDocument): string {
    return this.#crypto.decrypt(document.objectKeyCiphertext, "document-object-key");
  }

  #operationalCapabilityState(): "SANDBOX" | "LIVE" {
    const state = this.capabilities.getState("OBJECT_STORAGE");
    if (state !== "SANDBOX" && state !== "LIVE") {
      throw new Error("Object storage capability changed during the operation");
    }
    return state;
  }

  #project(document: StoredDocument): DocumentMetadataProjection {
    const { objectKeyCiphertext: _privateObjectKey, ...projection } = document;
    return Object.freeze(projection);
  }

  #assertOwner(principal: AuthPrincipal): void {
    if (!principal.roles.includes("OWNER")) {
      throw new DocumentValidationError("OWNER_ROLE_REQUIRED", "Owner role is required");
    }
  }

  #assertContext(context: CatalogRequestContext): void {
    if (context.correlationId.trim().length === 0) {
      throw new TypeError("correlationId must not be empty");
    }
  }
}

const requireIdentifier = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new DocumentValidationError("INVALID_RESOURCE_ID", "Invalid resource identifier");
  }
  return trimmed;
};

const sanitizeFileName = (value: string): string => {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 180 ||
    /[\u0000-\u001f\u007f/\\]/u.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new DocumentValidationError("INVALID_FILE_NAME", "Invalid document file name");
  }
  return trimmed;
};

const normalizeMediaType = (value: string): string =>
  value.split(";", 1)[0]?.trim().toLowerCase() ?? "";

export const detectDocumentMime = (bytes: Uint8Array): DocumentMimeType | undefined => {
  const b = Buffer.from(bytes);
  if (b.length >= 5 && b.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "image/png";
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString("ascii") === "RIFF" &&
    b.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  return undefined;
};
