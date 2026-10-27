import { CORRELATION_ID_HEADER, resolveCorrelationId } from "@kisantractor/observability";

/**
 * The correlation ID a route handler forwards to the API: the caller's value
 * when it is a valid opaque token, otherwise a new UUID. Unvalidated header
 * values are never forwarded, so clients cannot inject PII into API logs.
 */
export function forwardCorrelationId(request: Request): string {
  return resolveCorrelationId(request.headers.get(CORRELATION_ID_HEADER)).correlationId;
}
