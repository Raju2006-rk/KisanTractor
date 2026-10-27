import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import { validateEnvironment, type EnvironmentConfig } from "@kisantractor/config";
import type {
  PrivateDownloadGrant,
  PrivateDownloadGrantRequest,
  PrivateObjectInspection,
  PrivateObjectStorageProvider,
  PrivateUploadGrant,
  PrivateUploadGrantRequest,
} from "@kisantractor/providers";
import type { INestApplication } from "@nestjs/common";

import type { DocumentMalwareScanner } from "../catalog/index.js";
import type { RuntimeSecrets } from "../runtime-config.js";

/**
 * Validated test-profile configuration for the vertical slice. OTP runs on the explicitly
 * labelled local sandbox adapter and object storage on the in-process sandbox below; every
 * other provider stays UNCONFIGURED, so no external side effect can occur.
 */
export function verticalSliceConfig(databaseUrl: string): Readonly<EnvironmentConfig> {
  return validateEnvironment({
    APP_ENV: "test",
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: "error",
    OTP_CAPABILITY_STATE: "SANDBOX",
    ALLOW_LOCAL_OTP_CODES: "true",
    STORAGE_CAPABILITY_STATE: "SANDBOX",
  });
}

/** Fresh random key material per run; nothing is read from or written to disk. */
export function ephemeralSecrets(): RuntimeSecrets {
  const key = () => Uint8Array.from(randomBytes(32));
  return Object.freeze({
    FIELD_ENCRYPTION_KEY: key(),
    LOOKUP_HASH_KEY: key(),
    OTP_HASH_KEY: key(),
    SESSION_HASH_KEY: key(),
    PHONE_ENCRYPTION_KEY: key(),
    DISCOVERY_CURSOR_SIGNING_KEY: key(),
  });
}

/**
 * A manually advanced server clock for domain services. It starts ahead of the database clock
 * so rows stamped with CURRENT_TIMESTAMP (for example pricing validity) are never in its future.
 */
export class DomainClock {
  #now: number;

  constructor(start = Date.now() + 10 * 60_000) {
    this.#now = start;
  }

  readonly now = (): Date => new Date(this.#now);

  advanceMinutes(minutes: number): void {
    this.#now += minutes * 60_000;
  }
}

interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
}

/**
 * In-process SANDBOX private object store. Grants point at a non-routable `.invalid` host, and
 * the harness plays the browser's direct upload with `upload`. Inspection reports what was
 * actually stored, so the document service validates real bytes rather than declared metadata.
 */
export class SandboxObjectStorage implements PrivateObjectStorageProvider {
  readonly #granted = new Set<string>();
  readonly #objects = new Map<string, StoredObject>();

  async issueUploadGrant(request: PrivateUploadGrantRequest): Promise<PrivateUploadGrant> {
    this.#granted.add(request.objectKey);
    return Object.freeze({
      url: `https://sandbox-storage.invalid/upload/${encodeURIComponent(request.objectKey)}`,
      method: "PUT" as const,
      expiresAt: request.expiresAt,
      encryptionAlgorithm: request.encryptionAlgorithm,
      requiredHeaders: Object.freeze({
        "content-type": request.contentType,
        "x-amz-server-side-encryption": request.encryptionAlgorithm,
      }),
    });
  }

  /** Simulates the client's PUT to the grant URL. */
  upload(grantUrl: string, bytes: Uint8Array, contentType: string): void {
    const url = new URL(grantUrl);
    const objectKey = decodeURIComponent(url.pathname.replace(/^\/upload\//u, ""));
    if (url.hostname !== "sandbox-storage.invalid" || !this.#granted.has(objectKey)) {
      throw new Error("No sandbox upload grant exists for this URL");
    }
    this.#objects.set(objectKey, { bytes: Buffer.from(bytes), contentType });
  }

  async inspectObject(objectKey: string, signatureByteLimit: number): Promise<PrivateObjectInspection> {
    const stored = this.#objects.get(objectKey);
    if (stored === undefined) throw new Error("The sandbox object has not been uploaded");
    return Object.freeze({
      contentLength: stored.bytes.length,
      contentType: stored.contentType,
      signatureBytes: Uint8Array.from(stored.bytes.subarray(0, signatureByteLimit)),
      contentDigest: createHash("sha256").update(stored.bytes).digest("hex"),
      encryptionAlgorithm: "AES256" as const,
    });
  }

  async issueDownloadGrant(request: PrivateDownloadGrantRequest): Promise<PrivateDownloadGrant> {
    if (!this.#objects.has(request.objectKey)) throw new Error("The sandbox object does not exist");
    return Object.freeze({
      url: `https://sandbox-storage.invalid/download/${encodeURIComponent(request.objectKey)}`,
      method: "GET" as const,
      expiresAt: request.expiresAt,
    });
  }
}

/** Labelled sandbox scanner: reports every inspected object clean. Never used outside tests. */
export const sandboxCleanScanner: DocumentMalwareScanner = Object.freeze({
  scan: async () => "CLEAN" as const,
});

export interface HttpResult<Body = any> {
  readonly status: number;
  readonly body: Body;
  readonly headers: Headers;
}

/** One authenticated client channel talking to the API over real HTTP. */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    readonly userAgent: string,
    readonly accessCredential?: string,
  ) {}

  withCredential(accessCredential: string): ApiClient {
    return new ApiClient(this.baseUrl, this.userAgent, accessCredential);
  }

  async request<Body = any>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<HttpResult<Body>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": this.userAgent,
        "x-client-channel": "WEB",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.accessCredential === undefined ? {} : { authorization: `Bearer ${this.accessCredential}` }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text), headers: response.headers };
  }

  get<Body = any>(path: string) {
    return this.request<Body>("GET", path);
  }

  post<Body = any>(path: string, body?: unknown, headers?: Readonly<Record<string, string>>) {
    return this.request<Body>("POST", path, body ?? {}, headers);
  }

  put<Body = any>(path: string, body: unknown) {
    return this.request<Body>("PUT", path, body);
  }
}

export function listeningBaseUrl(app: INestApplication): string {
  const address = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/** Fields both parties must see identically for the same booking (Requirement 1.2). */
export const SHARED_BOOKING_FIELDS = [
  "id", "publicReference", "status", "version", "bookingTarget", "requestedInterval", "serviceLocation",
  "tractor", "serviceName", "equipmentName", "recipient", "quoteSnapshot", "invoice", "payment",
  "statusHistory", "createdAt", "updatedAt",
] as const;

export function sharedBookingState(view: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(SHARED_BOOKING_FIELDS.filter((field) => field in view).map((field) => [field, view[field]]));
}

export function partyOnlyFields(view: Record<string, unknown>): string[] {
  return Object.keys(view).filter((key) => !(SHARED_BOOKING_FIELDS as readonly string[]).includes(key)).sort();
}
