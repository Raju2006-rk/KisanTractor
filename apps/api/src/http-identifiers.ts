/** Every persisted aggregate identifier is a UUID. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * True when a request-supplied identifier is well formed. Routes check identifiers at the
 * HTTP boundary so malformed or hostile input is refused with a stable 4xx code and never
 * reaches SQL as a value the database would reject with a driver error.
 */
export const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value.trim());

/** Database error codes for constraint and input-shape violations, never surfaced verbatim. */
export const UNIQUE_VIOLATION = "23505";

export const databaseErrorCode = (error: unknown): string | undefined => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
};
