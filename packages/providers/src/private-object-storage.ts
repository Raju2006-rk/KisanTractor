export const privateObjectEncryptionAlgorithms = [
  "AES256",
  "aws:kms",
] as const;

export type PrivateObjectEncryptionAlgorithm =
  (typeof privateObjectEncryptionAlgorithms)[number];

export interface PrivateUploadGrantRequest {
  readonly objectKey: string;
  readonly contentType: string;
  readonly contentLength: number;
  readonly expiresAt: Date;
  readonly encryptionAlgorithm: PrivateObjectEncryptionAlgorithm;
}

export interface PrivateUploadGrant {
  readonly url: string;
  readonly method: "PUT";
  readonly expiresAt: Date;
  readonly encryptionAlgorithm: PrivateObjectEncryptionAlgorithm;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface PrivateObjectInspection {
  readonly contentLength: number;
  readonly contentType: string;
  readonly signatureBytes: Uint8Array;
  readonly contentDigest: string;
  readonly encryptionAlgorithm?: PrivateObjectEncryptionAlgorithm;
}

export interface PrivateDownloadGrantRequest {
  readonly objectKey: string;
  readonly expiresAt: Date;
  readonly downloadFileName: string;
}

export interface PrivateDownloadGrant {
  readonly url: string;
  readonly method: "GET";
  readonly expiresAt: Date;
}

/**
 * Adapter contract for a private object store. Implementations must inspect
 * authoritative object metadata rather than trusting upload-completion input.
 */
export interface PrivateObjectStorageProvider {
  issueUploadGrant(request: PrivateUploadGrantRequest): Promise<PrivateUploadGrant>;
  inspectObject(objectKey: string, signatureByteLimit: number): Promise<PrivateObjectInspection>;
  issueDownloadGrant(request: PrivateDownloadGrantRequest): Promise<PrivateDownloadGrant>;
}
