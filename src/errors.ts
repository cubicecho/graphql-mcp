/**
 * The one way this package raises an error about how it was configured, so every
 * message names where it came from.
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
