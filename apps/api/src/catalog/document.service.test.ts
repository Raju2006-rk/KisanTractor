import type {
  AuthPrincipal,
  BookingAuthorizationResource,
  DocumentAuthorizationResource,
  TractorAuthorizationResource,
} from "@kisantractor/domain";
import {
  CapabilityRegistry,
  CapabilityUnavailableError,
  type PrivateDownloadGrantRequest,
  type PrivateObjectInspection,
  type PrivateObjectStorageProvider,
  type PrivateUploadGrantRequest,
} from "@kisantractor/providers";
import { describe, expect, it } from "vitest";

import {
  AuthorizationService,
  type AuthorizationStore,
} from "../authorization/index.js";
import type { CatalogRequestContext, CatalogSecrets } from "./catalog.contracts.js";
import type {
  DocumentMalwareScanner,
  DocumentStore,
  InspectedDocumentInput,
  PendingDocumentInput,
  StoredDocument,
} from "./document.contracts.js";
import {
  DocumentScanUnavailableError,
  DocumentStateError,
  DocumentValidationError,
  PrivateDocumentService,
} from "./document.service.js";

const NOW = new Date("2025-06-01T10:00:00.000Z");
const context: CatalogRequestContext = {
  correlationId: "corr-document-5-3",
  actorChannel: "WEB",
};
const secrets: CatalogSecrets = {
  fieldEncryptionKey: Buffer.alloc(32, 7),
  lookupHashKey: Buffer.alloc(32, 9),
};
const owner = (userId = "owner-1"): AuthPrincipal => ({
  userId,
  sessionId: `session-${userId}`,
  roles: ["OWNER"],
});
const validRequest = {
  tractorId: "tractor-1",
  documentKind: "registration_certificate",
  fileName: "registration.pdf",
  declaredMimeType: "application/pdf",
  sizeBytes: 12,
} as const;

class MemoryDocumentStore implements DocumentStore {
  readonly documents = new Map<string, StoredDocument>();
  readonly downloadAudits: string[] = [];
  sequence = 0;

  async createPending(ownerId: string, input: PendingDocumentInput) {
    if (input.tractorId === "tractor-other" || input.equipmentId === "equipment-other") {
      return undefined;
    }
    const document: StoredDocument = Object.freeze({
      id: `document-${++this.sequence}`,
      ownerId,
      ...(input.tractorId === undefined ? {} : { tractorId: input.tractorId }),
      ...(input.equipmentId === undefined ? {} : { equipmentId: input.equipmentId }),
      documentKind: input.documentKind,
      fileName: input.fileName,
      declaredMimeType: input.declaredMimeType,
      declaredSizeBytes: input.declaredSizeBytes,
      objectKeyCiphertext: input.objectKeyCiphertext,
      scanStatus: "PENDING_UPLOAD",
      uploadGrantExpiresAt: input.uploadGrantExpiresAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      version: 1,
    });
    this.documents.set(document.id, document);
    return document;
  }

  async findById(documentId: string) {
    return this.documents.get(documentId);
  }

  async listByOwner(ownerId: string) {
    return [...this.documents.values()].filter((document) => document.ownerId === ownerId).reverse();
  }

  async markPendingScan(
    documentId: string,
    ownerId: string,
    _actorId: string,
    input: InspectedDocumentInput,
  ) {
    const current = this.documents.get(documentId);
    if (!current || current.ownerId !== ownerId || current.scanStatus !== "PENDING_UPLOAD") {
      return undefined;
    }
    const changed: StoredDocument = Object.freeze({
      ...current,
      ...input,
      scanStatus: "PENDING_SCAN",
      version: current.version + 1,
    });
    this.documents.set(documentId, changed);
    return changed;
  }

  async markAccepted(documentId: string, ownerId: string) {
    const current = this.documents.get(documentId);
    if (!current || current.ownerId !== ownerId || current.scanStatus !== "PENDING_SCAN") {
      return undefined;
    }
    const changed: StoredDocument = Object.freeze({
      ...current,
      scanStatus: "ACCEPTED",
      scanCompletedAt: NOW,
      acceptedAt: NOW,
      version: current.version + 1,
    });
    this.documents.set(documentId, changed);
    return changed;
  }

  async markRejected(
    documentId: string,
    ownerId: string,
    _actorId: string,
    rejectionCode: string,
  ) {
    const current = this.documents.get(documentId);
    if (
      !current ||
      current.ownerId !== ownerId ||
      (current.scanStatus !== "PENDING_UPLOAD" && current.scanStatus !== "PENDING_SCAN")
    ) return undefined;
    const changed: StoredDocument = Object.freeze({
      ...current,
      scanStatus: "REJECTED",
      rejectionCode,
      scanCompletedAt: NOW,
      version: current.version + 1,
    });
    this.documents.set(documentId, changed);
    return changed;
  }

  async recordDownloadGrant(documentId: string, actorId: string) {
    this.downloadAudits.push(`${documentId}:${actorId}`);
  }
}

class DocumentAuthorizationStore implements AuthorizationStore {
  constructor(private readonly documents: MemoryDocumentStore) {}

  async findDocumentResource(id: string): Promise<DocumentAuthorizationResource | undefined> {
    const document = this.documents.documents.get(id);
    if (!document) return undefined;
    return {
      kind: "DOCUMENT",
      id,
      ownerId: document.ownerId,
      ...(document.tractorId === undefined ? {} : { tractorId: document.tractorId }),
    };
  }

  async findBookingResource(): Promise<BookingAuthorizationResource | undefined> {
    return undefined;
  }

  async findTractorResource(): Promise<TractorAuthorizationResource | undefined> {
    return undefined;
  }
}

class RecordingPrivateObjectStorage implements PrivateObjectStorageProvider {
  readonly uploads: PrivateUploadGrantRequest[] = [];
  readonly inspections: string[] = [];
  readonly downloads: PrivateDownloadGrantRequest[] = [];
  inspection: PrivateObjectInspection = {
    contentLength: 12,
    contentType: "application/pdf",
    signatureBytes: Buffer.from("%PDF-1.7", "ascii"),
    contentDigest: "a".repeat(64),
    encryptionAlgorithm: "AES256",
  };

  async issueUploadGrant(request: PrivateUploadGrantRequest) {
    this.uploads.push(request);
    return {
      url: `https://objects.example.test/upload?key=${encodeURIComponent(request.objectKey)}`,
      method: "PUT" as const,
      expiresAt: request.expiresAt,
      encryptionAlgorithm: request.encryptionAlgorithm,
      requiredHeaders: { "content-type": request.contentType },
    };
  }

  async inspectObject(objectKey: string) {
    this.inspections.push(objectKey);
    return this.inspection;
  }

  async issueDownloadGrant(request: PrivateDownloadGrantRequest) {
    this.downloads.push(request);
    return {
      url: `https://objects.example.test/download?key=${encodeURIComponent(request.objectKey)}`,
      method: "GET" as const,
      expiresAt: request.expiresAt,
    };
  }
}

class StaticScanner implements DocumentMalwareScanner {
  readonly scans: string[] = [];

  constructor(public result: "CLEAN" | "INFECTED" | "UNAVAILABLE" = "CLEAN") {}

  async scan(input: { readonly objectKey: string; readonly contentDigest: string }) {
    this.scans.push(`${input.objectKey}:${input.contentDigest}`);
    return this.result;
  }
}

const setup = (
  state: "UNCONFIGURED" | "SANDBOX" | "LIVE" = "SANDBOX",
) => {
  const store = new MemoryDocumentStore();
  const provider = new RecordingPrivateObjectStorage();
  const scanner = new StaticScanner();
  const capabilities = state === "UNCONFIGURED"
    ? new CapabilityRegistry()
    : new CapabilityRegistry({ OBJECT_STORAGE: { state, provider } });
  const authorization = new AuthorizationService(new DocumentAuthorizationStore(store));
  const service = new PrivateDocumentService(
    store,
    authorization,
    capabilities,
    secrets,
    scanner,
    () => new Date(NOW),
  );
  return { service, store, provider, scanner };
};

const issue = async (setupResult: ReturnType<typeof setup>) =>
  setupResult.service.issueUploadGrant(owner(), validRequest, context);

describe("PrivateDocumentService", () => {
  it("persists opaque metadata, accepts only clean encrypted content, and issues short authorized grants", async () => {
    const fixture = setup();
    const upload = await issue(fixture);

    expect(upload.capabilityState).toBe("SANDBOX");
    expect(upload.grant.expiresAt.getTime() - NOW.getTime()).toBe(10 * 60 * 1000);
    expect(upload.grant.encryptionAlgorithm).toBe("AES256");
    expect(upload.document).not.toHaveProperty("objectKeyCiphertext");
    const stored = fixture.store.documents.get(upload.document.id);
    expect(Buffer.from(stored?.objectKeyCiphertext ?? []).toString("utf8"))
      .not.toContain("private/documents/");

    const completed = await fixture.service.completeUpload(owner(), upload.document.id, context);
    expect(completed).toMatchObject({
      scanStatus: "ACCEPTED",
      detectedMimeType: "application/pdf",
      uploadedSizeBytes: 12,
      encryptionAlgorithm: "AES256",
    });
    expect(fixture.scanner.scans).toHaveLength(1);

    const download = await fixture.service.issueDownloadGrant(owner(), upload.document.id, context);
    expect(download.grant.expiresAt.getTime() - NOW.getTime()).toBe(2 * 60 * 1000);
    expect(download.grant.url).toMatch(/^https:/u);
    expect(fixture.store.downloadAudits).toEqual([`${upload.document.id}:owner-1`]);
  });

  it("lists only the calling Owner's document metadata, without object keys", async () => {
    const fixture = setup();
    const mine = await issue(fixture);
    await fixture.service.issueUploadGrant(owner("owner-2"), validRequest, context);

    const listed = await fixture.service.listOwnerDocuments(owner());
    expect(listed.map((document) => document.id)).toEqual([mine.document.id]);
    expect(listed[0]).not.toHaveProperty("objectKeyCiphertext");
    await expect(fixture.service.listOwnerDocuments({ ...owner(), roles: ["FARMER"] }))
      .rejects.toMatchObject({ reasonCode: "OWNER_ROLE_REQUIRED" });
  });

  it("rejects extension, MIME, traversal, and size claims before persistence or provider effects", async () => {
    const fixture = setup();
    const invalidInputs = [
      { ...validRequest, fileName: "registration.png" },
      { ...validRequest, fileName: "../registration.pdf" },
      { ...validRequest, declaredMimeType: "text/html" },
      { ...validRequest, sizeBytes: 10 * 1024 * 1024 + 1 },
    ];

    for (const input of invalidInputs) {
      await expect(fixture.service.issueUploadGrant(owner(), input, context))
        .rejects.toBeInstanceOf(DocumentValidationError);
    }
    expect(fixture.store.documents.size).toBe(0);
    expect(fixture.provider.uploads).toHaveLength(0);
  });

  it("keeps unconfigured storage unavailable without metadata or external effects", async () => {
    const fixture = setup("UNCONFIGURED");

    await expect(issue(fixture)).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityUnavailableError>>({
        code: "CAPABILITY_UNAVAILABLE",
        capability: "OBJECT_STORAGE",
        state: "UNCONFIGURED",
        retryable: false,
      }),
    );
    expect(fixture.store.documents.size).toBe(0);
    expect(fixture.provider.uploads).toHaveLength(0);
  });

  it("rejects MIME/signature, size, digest, and encryption mismatches before scanning", async () => {
    const inspections: Array<[Partial<PrivateObjectInspection>, string]> = [
      [{ signatureBytes: Buffer.from("not-pdf") }, "MIME_SIGNATURE_MISMATCH"],
      [{ contentLength: 11 }, "SIZE_MISMATCH"],
      [{ contentDigest: "not-a-sha256" }, "INVALID_CONTENT_DIGEST"],
      [{ encryptionAlgorithm: "aws:kms" }, "OBJECT_NOT_ENCRYPTED"],
    ];

    for (const [patch, reason] of inspections) {
      const fixture = setup();
      const upload = await issue(fixture);
      fixture.provider.inspection = { ...fixture.provider.inspection, ...patch };
      const result = await fixture.service.completeUpload(owner(), upload.document.id, context);
      expect(result).toMatchObject({ scanStatus: "REJECTED", rejectionCode: reason });
      expect(fixture.scanner.scans).toHaveLength(0);
    }
  });

  it("retains pending scan state when scanning is unavailable and rejects infected objects", async () => {
    const unavailable = setup();
    const pendingUpload = await issue(unavailable);
    unavailable.scanner.result = "UNAVAILABLE";
    await expect(
      unavailable.service.completeUpload(owner(), pendingUpload.document.id, context),
    ).rejects.toBeInstanceOf(DocumentScanUnavailableError);
    expect(unavailable.store.documents.get(pendingUpload.document.id)?.scanStatus)
      .toBe("PENDING_SCAN");

    unavailable.scanner.result = "INFECTED";
    const rejected = await unavailable.service.completeUpload(
      owner(),
      pendingUpload.document.id,
      context,
    );
    expect(rejected).toMatchObject({
      scanStatus: "REJECTED",
      rejectionCode: "MALWARE_DETECTED",
    });
    await expect(
      unavailable.service.issueDownloadGrant(owner(), pendingUpload.document.id, context),
    ).rejects.toBeInstanceOf(DocumentStateError);
  });

  it("denies an unrelated Owner before issuing a private download grant", async () => {
    const fixture = setup("LIVE");
    const upload = await issue(fixture);
    await fixture.service.completeUpload(owner(), upload.document.id, context);

    await expect(
      fixture.service.issueDownloadGrant(owner("owner-2"), upload.document.id, context),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(fixture.provider.downloads).toHaveLength(0);
    expect(fixture.store.downloadAudits).toHaveLength(0);
  });
});

/** Validates: Requirements 14.2, 14.4, 18.7 */
describe("object storage capability rollback", () => {
  for (const rolledBackTo of ["DEGRADED", "UNCONFIGURED"] as const) {
    it(`leaves documents untouched and calls no provider after a rollback to ${rolledBackTo}, then resumes on roll-forward`, async () => {
      const fixture = setup("SANDBOX");
      const accepted = await issue(fixture);
      await fixture.service.completeUpload(owner(), accepted.document.id, context);
      const inFlight = await issue(fixture);
      const restart = (capabilities: CapabilityRegistry) => new PrivateDocumentService(
        fixture.store, new AuthorizationService(new DocumentAuthorizationStore(fixture.store)), capabilities, secrets,
        fixture.scanner, () => new Date(NOW),
      );
      const rolledBack = restart(new CapabilityRegistry(rolledBackTo === "DEGRADED"
        ? { OBJECT_STORAGE: { state: "DEGRADED" } }
        : {}));
      const documentsSnapshot = () => JSON.stringify([...fixture.store.documents.entries()]);
      const documentsBefore = documentsSnapshot();
      const providerCalls = () => ({
        uploads: fixture.provider.uploads.length,
        inspections: fixture.provider.inspections.length,
        downloads: fixture.provider.downloads.length,
        scans: fixture.scanner.scans.length,
      });
      const callsBefore = providerCalls();

      for (const attempt of [
        () => rolledBack.issueUploadGrant(owner(), validRequest, context),
        () => rolledBack.completeUpload(owner(), inFlight.document.id, context),
        () => rolledBack.issueDownloadGrant(owner(), accepted.document.id, context),
      ]) {
        const error = await attempt().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CapabilityUnavailableError);
        expect(error).toMatchObject({ capability: "OBJECT_STORAGE", state: rolledBackTo, retryable: rolledBackTo === "DEGRADED" });
      }
      expect(documentsSnapshot()).toBe(documentsBefore);
      expect(fixture.store.downloadAudits).toHaveLength(0);
      expect(providerCalls()).toEqual(callsBefore);
      // Metadata stays readable, so Owners and eligibility checks still see their documents.
      expect((await rolledBack.listOwnerDocuments(owner())).map(({ scanStatus }) => scanStatus).sort())
        .toEqual(["ACCEPTED", "PENDING_UPLOAD"]);

      // Rolling forward again needs no data repair: the in-flight upload completes.
      const restored = restart(new CapabilityRegistry({ OBJECT_STORAGE: { state: "SANDBOX", provider: fixture.provider } }));
      await expect(restored.completeUpload(owner(), inFlight.document.id, context)).resolves.toMatchObject({ scanStatus: "ACCEPTED" });
    });
  }
});
