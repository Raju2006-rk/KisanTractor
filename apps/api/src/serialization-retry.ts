/**
 * Bounded retry for SERIALIZABLE write transactions.
 *
 * PostgreSQL aborts a SERIALIZABLE transaction with 40001 when it cannot prove a serial order,
 * including for transactions that touched different rows but the same index pages or a table
 * scanned whole (for example a nearly empty table on launch day). It also aborts with 40P01 on
 * deadlock. The initial-load suite (task 15.3) showed these refusing valid actions: an adjacent,
 * non-overlapping acceptance lost to its neighbour, and parallel job starts on different bookings
 * failed. Each attempt runs a brand-new transaction with a fresh snapshot, so a retry re-reads
 * the committed state and either succeeds or fails with the real domain reason.
 *
 * The identity store has had the same policy since task 4; this is the shared form for the
 * booking, job, and payment stores.
 */
export const DEFAULT_SERIALIZATION_ATTEMPTS = 4;

const SERIALIZATION_FAILURE_CODES = new Set(["40001", "40P01"]);

export const databaseErrorCode = (error: unknown): string | undefined => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
};

export const isSerializationFailure = (error: unknown): boolean =>
  SERIALIZATION_FAILURE_CODES.has(databaseErrorCode(error) ?? "");

export interface SerializationRetryOptions {
  readonly attempts?: number;
  /** Extra codes to retry, such as 23P01 when the retry re-checks the same invariant. */
  readonly alsoRetry?: ReadonlySet<string>;
  /** Jittered pause before attempt `n` (2, 3, ...). */
  readonly pause?: (attempt: number) => Promise<void>;
}

const jitteredPause = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 10 * attempt)));

/**
 * Runs `transaction` until it commits, fails with a non-retryable error, or exhausts its
 * attempts. On exhaustion the last database error is rethrown unchanged, so callers keep their
 * existing mapping of 40001/23P01 to a conflict response.
 */
export async function retrySerializationFailures<Result>(
  transaction: () => Promise<Result>,
  options: SerializationRetryOptions = {},
): Promise<Result> {
  const attempts = options.attempts ?? DEFAULT_SERIALIZATION_ATTEMPTS;
  const pause = options.pause ?? jitteredPause;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      const retryable = isSerializationFailure(error) || options.alsoRetry?.has(databaseErrorCode(error) ?? "") === true;
      if (!retryable || attempt >= attempts) throw error;
      await pause(attempt + 1);
    }
  }
}
