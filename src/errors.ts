/**
 * How this package raises its own errors and reads the ones it catches.
 */

/** Opens every error message this package throws. */
const ERROR_PREFIX = 'graphql-mcp: ';

/**
 * An error whose message is `message` behind {@link ERROR_PREFIX}.
 *
 * @param message - What went wrong, without the prefix.
 * @param options - Passed to `Error`, for a `cause`.
 * @returns The error, for the caller to throw.
 */
export function packageError(message: string, options?: ErrorOptions): Error {
  return new Error(`${ERROR_PREFIX}${message}`, options);
}

/**
 * A thrown value's message, however it was thrown.
 *
 * @param cause - Whatever a `catch` received.
 * @param fallback - Used when `cause` says nothing: an `Error` with an empty
 *   message, or a plain object, whose string form is `[object Object]`.
 * @returns Text fit to show a caller.
 */
export function messageOf(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    return cause.message || fallback;
  }
  const text = String(cause);
  return text === '' || text === '[object Object]' ? fallback : text;
}
