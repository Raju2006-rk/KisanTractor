import { randomUUID } from "node:crypto";

import type { AuthPrincipal } from "@kisantractor/domain";
import { CapabilityUnavailableError } from "@kisantractor/providers";
import { Body, Controller, Get, Headers, HttpException, Inject, Param, Post, Req } from "@nestjs/common";

import { AuthorizationDeniedError } from "../authorization/index.js";
import { isIdentifier } from "../http-identifiers.js";
import { AuthenticationRejectedError } from "../identity/identity.service.js";
import type { CatalogRequestContext } from "./catalog.contracts.js";
import type { DocumentSessionAuthenticator, DocumentUploadRequest } from "./document.contracts.js";
import {
  DocumentScanUnavailableError,
  DocumentStateError,
  DocumentValidationError,
  InvalidObjectStorageGrantError,
  PrivateDocumentService,
} from "./document.service.js";

export const DOCUMENT_AUTHENTICATOR = Symbol("DOCUMENT_AUTHENTICATOR");
export const PRIVATE_DOCUMENT_SERVICE = Symbol("PRIVATE_DOCUMENT_SERVICE");

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

interface DocumentUploadBody extends Omit<DocumentUploadRequest, "expiresAt"> {
  readonly expiresAt?: string;
}

const NOT_FOUND = (): HttpException => new HttpException({ code: "NOT_FOUND" }, 404);

const bearerCredential = (request: HttpRequestLike): string => {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = typeof value === "string" ? /^Bearer\s+(.+)$/iu.exec(value.trim()) : null;
  if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return match[1];
};

const requestContext = (
  request: HttpRequestLike,
  correlationId: string | undefined,
): CatalogRequestContext => {
  const requestedChannel = request.headers["x-client-channel"];
  const value = Array.isArray(requestedChannel) ? requestedChannel[0] : requestedChannel;
  return {
    correlationId: correlationId?.trim() || randomUUID(),
    actorChannel: value === "PWA" || value === "MOBILE" ? value : "WEB",
  };
};

const invalid = (reasonCode: string, message: string): DocumentValidationError =>
  new DocumentValidationError(reasonCode, message);

/** Checks the upload request's shape so malformed bodies are a 422, never a driver or type error. */
const uploadRequest = (body: DocumentUploadBody | undefined): DocumentUploadRequest => {
  if (typeof body !== "object" || body === null) throw invalid("INVALID_REQUEST", "A JSON object body is required");
  const { expiresAt, ...metadata } = body;
  for (const field of ["tractorId", "equipmentId"] as const) {
    if (metadata[field] !== undefined && !isIdentifier(metadata[field])) {
      throw invalid("INVALID_RESOURCE_ID", "Invalid resource identifier");
    }
  }
  if (typeof metadata.documentKind !== "string") throw invalid("INVALID_DOCUMENT_KIND", "Invalid document kind");
  if (typeof metadata.fileName !== "string") throw invalid("INVALID_FILE_NAME", "Invalid document file name");
  if (typeof metadata.declaredMimeType !== "string") throw invalid("UNSUPPORTED_MIME_TYPE", "Unsupported document MIME type");
  if (typeof metadata.sizeBytes !== "number") throw invalid("INVALID_SIZE", "Document size must be a number of bytes");
  let expiry: Date | undefined;
  if (expiresAt !== undefined) {
    expiry = typeof expiresAt === "string" ? new Date(expiresAt) : new Date(Number.NaN);
    if (Number.isNaN(expiry.getTime())) throw invalid("INVALID_EXPIRY", "Document expiry must be a valid date");
  }
  return { ...metadata, ...(expiry === undefined ? {} : { expiresAt: expiry }) };
};

/**
 * Maps private-document failures to stable machine codes. A document the caller may not access
 * is indistinguishable from a missing one, and no storage or driver detail is returned.
 */
export function toDocumentHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  if (error instanceof AuthorizationDeniedError) return NOT_FOUND();
  if (error instanceof DocumentValidationError) {
    if (error.reasonCode === "OWNER_ROLE_REQUIRED") return NOT_FOUND();
    return new HttpException({ code: error.code, reasonCode: error.reasonCode, message: error.message }, 422);
  }
  if (error instanceof DocumentStateError) return new HttpException({ code: error.code, message: error.message }, 409);
  if (error instanceof DocumentScanUnavailableError) {
    return new HttpException({ code: error.code, retryable: error.retryable, message: error.message }, 503);
  }
  if (error instanceof InvalidObjectStorageGrantError) return new HttpException({ code: error.code }, 502);
  if (error instanceof CapabilityUnavailableError) {
    return new HttpException({ code: error.code, capability: error.capability, state: error.state, retryable: error.retryable }, 503);
  }
  return error;
}

const run = async <Result>(work: () => Promise<Result>): Promise<Result> => {
  try {
    return await work();
  } catch (error) {
    throw toDocumentHttpError(error);
  }
};

@Controller("owner/documents")
export class PrivateDocumentController {
  constructor(
    @Inject(DOCUMENT_AUTHENTICATOR)
    private readonly authenticator: DocumentSessionAuthenticator,
    @Inject(PRIVATE_DOCUMENT_SERVICE)
    private readonly documents: PrivateDocumentService,
  ) {}

  /** The Owner's own document metadata; never object keys or access grants. */
  @Get()
  list(@Req() request: HttpRequestLike) {
    return run(async () => ({ items: await this.documents.listOwnerDocuments(await this.#principal(request)) }));
  }

  @Post("upload-grants")
  postUploadGrant(
    @Req() request: HttpRequestLike,
    @Body() body: DocumentUploadBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      return this.documents.issueUploadGrant(principal, uploadRequest(body), requestContext(request, correlationId));
    });
  }

  @Post(":documentId/complete")
  postComplete(
    @Req() request: HttpRequestLike,
    @Param("documentId") documentId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      if (!isIdentifier(documentId)) throw NOT_FOUND();
      return this.documents.completeUpload(principal, documentId.trim(), requestContext(request, correlationId));
    });
  }

  @Get(":documentId/download-grant")
  getDownloadGrant(
    @Req() request: HttpRequestLike,
    @Param("documentId") documentId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      if (!isIdentifier(documentId)) throw NOT_FOUND();
      return this.documents.issueDownloadGrant(principal, documentId.trim(), requestContext(request, correlationId));
    });
  }

  #principal(request: HttpRequestLike): Promise<AuthPrincipal> {
    return this.authenticator.authenticateAccessCredential(bearerCredential(request));
  }
}
