import type {
  BookingAuthorizationResource,
  DocumentAuthorizationResource,
  TractorAuthorizationResource,
} from "@kisantractor/domain";
import type { SqlPool } from "@kisantractor/database";

import type { AuthorizationStore } from "./authorization.contracts.js";

interface BookingScopeRow {
  readonly id: string;
  readonly customer_id: string;
  readonly owner_id: string;
}

interface OwnerScopeRow {
  readonly id: string;
  readonly owner_id: string;
}

interface DocumentScopeRow extends OwnerScopeRow {
  readonly tractor_id: string | null;
}

export class PostgresAuthorizationStore implements AuthorizationStore {
  constructor(private readonly pool: SqlPool) {}

  async findBookingResource(
    id: string,
  ): Promise<BookingAuthorizationResource | undefined> {
    const result = await this.pool.query<BookingScopeRow>(
      `SELECT b.id, b.customer_id, t.owner_id
         FROM public.bookings AS b
         INNER JOIN public.tractors AS t ON t.id = b.tractor_id
        WHERE b.id = $1
        LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return Object.freeze({
      kind: "BOOKING" as const,
      id: row.id,
      customerId: row.customer_id,
      ownerId: row.owner_id,
    });
  }

  async findTractorResource(
    id: string,
  ): Promise<TractorAuthorizationResource | undefined> {
    const result = await this.pool.query<OwnerScopeRow>(
      `SELECT id, owner_id
         FROM public.tractors
        WHERE id = $1
        LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return Object.freeze({
      kind: "TRACTOR" as const,
      id: row.id,
      ownerId: row.owner_id,
    });
  }

  async findDocumentResource(
    id: string,
  ): Promise<DocumentAuthorizationResource | undefined> {
    const result = await this.pool.query<DocumentScopeRow>(
      `SELECT id, owner_id, tractor_id
         FROM public.documents
        WHERE id = $1
        LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return Object.freeze({
      kind: "DOCUMENT" as const,
      id: row.id,
      ownerId: row.owner_id,
      ...(row.tractor_id === null ? {} : { tractorId: row.tractor_id }),
    });
  }
}
