import type { AuthPrincipal } from "@kisantractor/domain";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationDeniedError } from "../authorization/index.js";
import {
  type DocumentSessionAuthenticator,
} from "./document.contracts.js";
import {
  PrivateDocumentController,
} from "./document.controller.js";
import {
  DocumentValidationError,
  type PrivateDocumentService,
} from "./document.service.js";

const owner = (userId: string): AuthPrincipal => ({
  userId,
  sessionId: `session-${userId}`,
  roles: ["OWNER"],
});

const request = (credential: string) => ({
  headers: {
    authorization: `Bearer ${credential}`,
    "x-client-channel": "MOBILE",
  },
});

/** Validates: Requirements 4.5, 4.6 */
describe("PrivateDocumentController API", () => {
  it("preserves upload rejection details from declared MIME validation", async () => {
    const authenticateAccessCredential = vi.fn(async () => owner("owner-1"));
    const issueUploadGrant = vi.fn(async () => {
      throw new DocumentValidationError("UNSUPPORTED_MIME_TYPE", "Unsupported document MIME type");
    });
    const controller = new PrivateDocumentController(
      { authenticateAccessCredential } satisfies DocumentSessionAuthenticator,
      { issueUploadGrant } as unknown as PrivateDocumentService,
    );

    await expect(controller.postUploadGrant(request("owner-token"), {
      tractorId: "60000000-0000-4000-8000-000000000001",
      documentKind: "registration_certificate",
      fileName: "registration.html",
      declaredMimeType: "text/html" as "application/pdf",
      sizeBytes: 12,
    }, "corr-upload-rejected")).rejects.toMatchObject({
      status: 422,
      response: { code: "DOCUMENT_VALIDATION_FAILED", reasonCode: "UNSUPPORTED_MIME_TYPE" },
    });
    expect(authenticateAccessCredential).toHaveBeenCalledWith("owner-token");
    expect(issueUploadGrant).toHaveBeenCalledWith(
      owner("owner-1"),
      expect.objectContaining({ declaredMimeType: "text/html" }),
      { correlationId: "corr-upload-rejected", actorChannel: "MOBILE" },
    );
  });

  it("propagates cross-Owner document denial before returning a private grant", async () => {
    const issueDownloadGrant = vi.fn(async () => {
      throw new AuthorizationDeniedError();
    });
    const controller = new PrivateDocumentController(
      { authenticateAccessCredential: async () => owner("owner-2") },
      { issueDownloadGrant } as unknown as PrivateDocumentService,
    );

    await expect(controller.getDownloadGrant(
      request("owner-2-token"),
      "63000000-0000-4000-8000-000000000001",
      "corr-download-denied",
    )).rejects.toMatchObject({ status: 404, response: { code: "NOT_FOUND" } });
    expect(issueDownloadGrant).toHaveBeenCalledWith(
      owner("owner-2"),
      "63000000-0000-4000-8000-000000000001",
      { correlationId: "corr-download-denied", actorChannel: "MOBILE" },
    );
  });
});
