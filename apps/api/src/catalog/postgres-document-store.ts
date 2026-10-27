import type { PrivateObjectEncryptionAlgorithm } from "@kisantractor/providers";
import { withDomainTransaction, type SqlPool } from "@kisantractor/database";

import type { CatalogRequestContext } from "./catalog.contracts.js";
import type {
  DocumentMetadataProjection,
  DocumentMimeType,
  DocumentStore,
  InspectedDocumentInput,
  PendingDocumentInput,
  StoredDocument,
} from "./document.contracts.js";

interface DocumentRow extends Record<string, unknown> {
  readonly id: string;
  readonly owner_id: string;
  readonly tractor_id: string | null;
  readonly equipment_id: string | null;
  readonly document_kind: string;
  readonly original_file_name: string | null;
  readonly object_key: string;
  readonly declared_mime_type: DocumentMimeType;
  readonly detected_mime_type: DocumentMimeType | null;
  readonly size_bytes: string | number;
  readonly uploaded_size_bytes: string | number | null;
  readonly content_digest: string | null;
  readonly object_encryption_algorithm: PrivateObjectEncryptionAlgorithm | null;
  readonly scan_status: DocumentMetadataProjection["scanStatus"];
  readonly rejection_code: string | null;
  readonly upload_grant_expires_at: Date | null;
  readonly scan_completed_at: Date | null;
  readonly accepted_at: Date | null;
  readonly expires_at: Date | null;
  readonly version: number;
}

const documentSql = `SELECT id, owner_id, tractor_id, equipment_id, document_kind,
       original_file_name, object_key, declared_mime_type, detected_mime_type,
       size_bytes, uploaded_size_bytes, content_digest, object_encryption_algorithm,
       scan_status, rejection_code, upload_grant_expires_at, scan_completed_at,
       accepted_at, expires_at, version
  FROM public.documents`;

export class PostgresDocumentStore implements DocumentStore {
  constructor(private readonly pool: SqlPool) {}

  async createPending(
    ownerId: string,
    input: PendingDocumentInput,
    context: CatalogRequestContext,
  ): Promise<StoredDocument | undefined> {
    const documentId = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const result = await transaction.sql.query<{ readonly id: string }>(
          `INSERT INTO public.documents
             (owner_id, tractor_id, equipment_id, document_kind, original_file_name,
              object_key, declared_mime_type, size_bytes, scan_status,
              upload_grant_expires_at, expires_at)
           SELECT $1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, 'PENDING_UPLOAD',
                  $9::timestamptz, $10::timestamptz
            WHERE ($2::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM public.tractors t WHERE t.id = $2 AND t.owner_id = $1
                  ))
              AND ($3::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM public.equipment e WHERE e.id = $3 AND e.owner_id = $1
                  ))
              AND ($2::uuid IS NOT NULL OR $3::uuid IS NOT NULL)
           RETURNING id`,
          [
            ownerId,
            input.tractorId ?? null,
            input.equipmentId ?? null,
            input.documentKind,
            input.fileName,
            Buffer.from(input.objectKeyCiphertext).toString("base64"),
            input.declaredMimeType,
            input.declaredSizeBytes,
            input.uploadGrantExpiresAt.toISOString(),
            input.expiresAt?.toISOString() ?? null,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) return undefined;
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "document.upload.request",
          resourceType: "DOCUMENT",
          resourceId: row.id,
          outcome: "SUCCESS",
          metadata: {
            declaredMimeType: input.declaredMimeType,
            declaredSizeBytes: input.declaredSizeBytes,
          },
        });
        return row.id;
      },
    );
    return documentId === undefined ? undefined : this.findById(documentId);
  }

  async findById(documentId: string): Promise<StoredDocument | undefined> {
    const result = await this.pool.query<DocumentRow>(
      `${documentSql} WHERE id = $1 LIMIT 1`,
      [documentId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.#projection(row);
  }

  async listByOwner(ownerId: string): Promise<readonly StoredDocument[]> {
    // Served by documents (owner_id, created_at DESC, id DESC); bounded like other dashboard reads.
    const result = await this.pool.query<DocumentRow>(
      `${documentSql} WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
      [ownerId],
    );
    return result.rows.map((row) => this.#projection(row));
  }

  async markPendingScan(
    documentId: string,
    ownerId: string,
    actorId: string,
    input: InspectedDocumentInput,
    context: CatalogRequestContext,
  ): Promise<StoredDocument | undefined> {
    return this.#transition(
      documentId,
      ownerId,
      actorId,
      context,
      "document.scan.pending",
      `UPDATE public.documents SET
         detected_mime_type = $3, uploaded_size_bytes = $4, content_digest = $5,
         object_encryption_algorithm = $6, scan_status = 'PENDING_SCAN',
         rejection_code = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND owner_id = $2 AND scan_status = 'PENDING_UPLOAD'
       RETURNING id`,
      [input.detectedMimeType, input.uploadedSizeBytes, input.contentDigest, input.encryptionAlgorithm],
    );
  }

  async markAccepted(
    documentId: string,
    ownerId: string,
    actorId: string,
    context: CatalogRequestContext,
  ): Promise<StoredDocument | undefined> {
    return this.#transition(
      documentId,
      ownerId,
      actorId,
      context,
      "document.scan.accept",
      `UPDATE public.documents SET
         scan_status = 'ACCEPTED', scan_completed_at = CURRENT_TIMESTAMP,
         accepted_at = CURRENT_TIMESTAMP, rejection_code = NULL,
         version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND owner_id = $2 AND scan_status = 'PENDING_SCAN'
         AND detected_mime_type IS NOT NULL AND uploaded_size_bytes IS NOT NULL
         AND content_digest IS NOT NULL AND object_encryption_algorithm IS NOT NULL
       RETURNING id`,
      [],
    );
  }

  async markRejected(
    documentId: string,
    ownerId: string,
    actorId: string,
    rejectionCode: string,
    context: CatalogRequestContext,
  ): Promise<StoredDocument | undefined> {
    return this.#transition(
      documentId,
      ownerId,
      actorId,
      context,
      "document.scan.reject",
      `UPDATE public.documents SET
         scan_status = 'REJECTED', rejection_code = $3,
         scan_completed_at = CURRENT_TIMESTAMP,
         version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND owner_id = $2
         AND scan_status IN ('PENDING_UPLOAD', 'PENDING_SCAN')
       RETURNING id`,
      [rejectionCode],
      rejectionCode,
    );
  }

  async recordDownloadGrant(
    documentId: string,
    actorId: string,
    context: CatalogRequestContext,
  ): Promise<void> {
    await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "READ COMMITTED" },
      async (transaction) => {
        await transaction.appendAudit({
          actorId,
          actorChannel: context.actorChannel,
          action: "document.download.grant",
          resourceType: "DOCUMENT",
          resourceId: documentId,
          outcome: "SUCCESS",
        });
      },
    );
  }

  async #transition(
    documentId: string,
    ownerId: string,
    actorId: string,
    context: CatalogRequestContext,
    action: string,
    sql: string,
    additionalValues: readonly unknown[],
    reasonCode?: string,
  ): Promise<StoredDocument | undefined> {
    const changed = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const result = await transaction.sql.query<{ readonly id: string }>(
          sql,
          [documentId, ownerId, ...additionalValues],
        );
        if (result.rows[0] === undefined) return false;
        await transaction.appendAudit({
          actorId,
          actorChannel: context.actorChannel,
          action,
          resourceType: "DOCUMENT",
          resourceId: documentId,
          outcome: "SUCCESS",
          ...(reasonCode === undefined ? {} : { reasonCode }),
        });
        return true;
      },
    );
    return changed ? this.findById(documentId) : undefined;
  }

  #projection(row: DocumentRow): StoredDocument {
    return Object.freeze({
      id: row.id,
      ownerId: row.owner_id,
      ...(row.tractor_id === null ? {} : { tractorId: row.tractor_id }),
      ...(row.equipment_id === null ? {} : { equipmentId: row.equipment_id }),
      documentKind: row.document_kind,
      fileName: row.original_file_name ?? "document",
      objectKeyCiphertext: Buffer.from(row.object_key, "base64"),
      declaredMimeType: row.declared_mime_type,
      ...(row.detected_mime_type === null ? {} : { detectedMimeType: row.detected_mime_type }),
      declaredSizeBytes: Number(row.size_bytes),
      ...(row.uploaded_size_bytes === null ? {} : { uploadedSizeBytes: Number(row.uploaded_size_bytes) }),
      ...(row.content_digest === null ? {} : { contentDigest: row.content_digest }),
      ...(row.object_encryption_algorithm === null ? {} : {
        encryptionAlgorithm: row.object_encryption_algorithm,
      }),
      scanStatus: row.scan_status,
      ...(row.rejection_code === null ? {} : { rejectionCode: row.rejection_code }),
      ...(row.upload_grant_expires_at === null ? {} : {
        uploadGrantExpiresAt: new Date(row.upload_grant_expires_at),
      }),
      ...(row.scan_completed_at === null ? {} : { scanCompletedAt: new Date(row.scan_completed_at) }),
      ...(row.accepted_at === null ? {} : { acceptedAt: new Date(row.accepted_at) }),
      ...(row.expires_at === null ? {} : { expiresAt: new Date(row.expires_at) }),
      version: row.version,
    });
  }
}
