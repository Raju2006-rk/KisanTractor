import { randomUUID } from "node:crypto";

import { writeAuditEvent, type SqlPool } from "@kisantractor/database";

import type { SupportAccessPolicy, SupportAccessRequest } from "../authorization/authorization.contracts.js";
import type { SupportGrantScope } from "./support.contracts.js";

interface GrantRow extends Record<string, unknown> {
  readonly id: string;
  readonly case_id: string;
  readonly scope: SupportGrantScope;
  readonly case_status: "OPEN" | "RESOLVED";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface SupportAccessDecision {
  readonly allowed: boolean;
  readonly grantId?: string;
  readonly caseId?: string;
  readonly scope?: SupportGrantScope;
  /** Why access was refused, as a code. */
  readonly reasonCode?: "NOT_OPERATOR" | "RESOURCE_NOT_SUPPORTED" | "ACTION_NOT_SUPPORTED" | "NO_ACTIVE_GRANT";
}

/**
 * Server-side support access backed by explicit grants (task 16.5). A request is allowed only when
 * all of these hold for the exact booking:
 *
 * - the principal holds FUTURE_OPERATOR, and the account is active with an unrevoked membership;
 * - an unrevoked grant names this operator and this booking, and `now` is inside its window;
 * - `booking:read` needs a READ or RESOLVE grant; `booking:command` needs RESOLVE on an OPEN case.
 *
 * Tractors and private documents are never granted. Every evaluation for an operator is audited
 * with ids and codes only. Least privilege: no grant, no access, and the deny-all policy remains the
 * default wherever this policy is not wired in.
 */
export class PostgresSupportAccessPolicy implements SupportAccessPolicy {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async hasExplicitAccess(request: SupportAccessRequest): Promise<boolean> {
    return (await this.evaluate(request)).allowed;
  }

  async evaluate(request: SupportAccessRequest): Promise<SupportAccessDecision> {
    const decision = await this.#decide(request);
    // Farmer and Owner principals never reach support access; only operator checks are audited.
    if (decision.reasonCode !== "NOT_OPERATOR") {
      await writeAuditEvent(this.pool, {
        actorId: request.principal.userId,
        actorChannel: "OPERATOR",
        action: "support.access.check",
        resourceType: request.resource.kind === "BOOKING" ? "Booking" : request.resource.kind === "TRACTOR" ? "Tractor" : "Document",
        resourceId: request.resource.id,
        outcome: decision.allowed ? "ALLOWED" : "DENIED",
        ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
        correlationId: request.correlationId ?? `support-access:${randomUUID()}`,
        occurredAt: this.now(),
        metadata: {
          requestedAction: request.action,
          ...(decision.grantId === undefined ? {} : { grantId: decision.grantId }),
          ...(decision.caseId === undefined ? {} : { caseId: decision.caseId }),
          ...(decision.scope === undefined ? {} : { grantScope: decision.scope }),
        },
      });
    }
    return decision;
  }

  async #decide({ principal, action, resource }: SupportAccessRequest): Promise<SupportAccessDecision> {
    if (!principal.roles.includes("FUTURE_OPERATOR")) return { allowed: false, reasonCode: "NOT_OPERATOR" };
    if (resource.kind !== "BOOKING") return { allowed: false, reasonCode: "RESOURCE_NOT_SUPPORTED" };
    if (action !== "booking:read" && action !== "booking:command") return { allowed: false, reasonCode: "ACTION_NOT_SUPPORTED" };
    if (!UUID.test(principal.userId) || !UUID.test(resource.id)) return { allowed: false, reasonCode: "NO_ACTIVE_GRANT" };
    const scopes: readonly SupportGrantScope[] = action === "booking:read" ? ["READ", "RESOLVE"] : ["RESOLVE"];
    const result = await this.pool.query<GrantRow>(
      `SELECT g.id, g.case_id, g.scope, c.status AS case_status
       FROM public.support_access_grants g
       JOIN public.support_cases c ON c.id = g.case_id AND c.booking_id = g.booking_id
       JOIN public.users u ON u.id = g.operator_user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
       WHERE g.operator_user_id = $1::uuid AND g.booking_id = $2::uuid AND g.revoked_at IS NULL
         AND g.valid_from <= $3::timestamptz AND g.expires_at > $3::timestamptz
         AND g.scope = ANY($4::text[])
         AND ($5::boolean OR c.status = 'OPEN')
         AND EXISTS (
           SELECT 1 FROM public.user_role_memberships m
           WHERE m.user_id = g.operator_user_id AND m.role_code = 'FUTURE_OPERATOR' AND m.revoked_at IS NULL
         )
       ORDER BY (c.status = 'OPEN') DESC, g.expires_at DESC, g.id
       LIMIT 1`,
      [principal.userId, resource.id, this.now().toISOString(), scopes, action === "booking:read"],
    );
    const grant = result.rows[0];
    return grant === undefined
      ? { allowed: false, reasonCode: "NO_ACTIVE_GRANT" }
      : { allowed: true, grantId: grant.id, caseId: grant.case_id, scope: grant.scope };
  }
}
