/**
 * Turns a {@link GraphqlResult} into the `CallToolResult` an agent actually
 * reads. Shared by the generated tools (`server.ts`) and the `execute` meta tool
 * (`meta.ts`) so both report success, failure, and size the same way.
 *
 * Three things matter here, and all three are about the *agent's* experience:
 *
 * - **Partial results are not failures.** GraphQL returns `data` *and* `errors`
 *   when some fields resolve and others don't. Flagging that whole call
 *   `isError` makes an agent discard rows it could have used, so `isError`
 *   tracks whether anything usable came back — not whether `errors` is
 *   non-empty. "Usable" means at least one root field is non-null: a nullable
 *   root field whose resolver threw still yields `data: { field: null }`, which
 *   is a total failure of that call however present `data` looks.
 * - **Errors are trimmed to what an agent can act on.** A GraphQL error's
 *   `locations` are line/column offsets into a query string the agent never
 *   wrote and cannot see; reporting them invites nonsense self-correction.
 *   `message`, `path`, and `extensions` (which carry app-level codes like
 *   `UNAUTHENTICATED`) survive — but only when they hold something, since
 *   graphql-js populates `extensions` on every error whether or not the server
 *   put anything in it.
 * - **Results are clamped.** A tool that returns a large collection would
 *   otherwise flood the agent's context with no warning. The truncation note
 *   carries a pagination hint when the field has an argument to page with,
 *   since "this was cut" on its own leaves an agent with no move but to re-run
 *   the identical call.
 *
 * The text is always pure JSON, so a client can parse it directly — which is why
 * {@link runExecutor} exists: an executor that *throws* would otherwise reach
 * the SDK, which reports the bare message as text and breaks that promise on
 * exactly the failure a client most needs to handle.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GraphqlError, GraphqlExecutor, GraphqlRequest, GraphqlResult } from './types.ts';

/** Default character budget for a tool result before truncation. */
export const DEFAULT_MAX_CHARS = 50_000;

/**
 * Truncates `value` to `maxChars`, appending a note that says how much was cut
 * and what to do about it.
 *
 * @param value - The text to clamp.
 * @param maxChars - Character budget.
 * @param hint - Optional extra advice appended to the note — {@link paginationHint}
 *   supplies one naming the field's paging argument.
 */
export function clamp(value: string, maxChars: number, hint?: string): string {
  if (value.length <= maxChars) return value;
  const advice = `narrow the query or request fewer fields${hint ? `. ${hint}` : ''}`;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} of ${value.length} characters — ${advice}]`;
}

/** Wraps a plain body as a (clamped) text tool result. */
export function text(body: string, maxChars = DEFAULT_MAX_CHARS): CallToolResult {
  return { content: [{ type: 'text', text: clamp(body, maxChars) }] };
}

/**
 * Wraps a GraphQL result as an MCP tool result.
 *
 * `isError` is set only when no data came back, so a partial result stays usable
 * — it carries a `note` explaining that some fields failed. Errors are condensed
 * to `message`/`path`/`extensions`, and the JSON is clamped to `maxChars`.
 *
 * @param result - The executor's GraphQL result.
 * @param maxChars - Character budget before truncation.
 * @param hint - Optional advice added to the truncation note (see {@link clamp}).
 */
export function toCallToolResult(
  result: GraphqlResult,
  maxChars = DEFAULT_MAX_CHARS,
  hint?: string,
): CallToolResult {
  const errors = result.errors ?? [];
  const hasData = hasUsableData(result.data);
  const failed = errors.length > 0 && !hasData;

  const payload: Record<string, unknown> = {};
  if (result.data !== undefined) payload.data = result.data;
  if (errors.length) payload.errors = errors.map(condense);
  if (errors.length && hasData) {
    payload.note =
      'Partial result: some fields failed and are null in `data`; the rest is valid. See `errors`.';
  }

  return {
    content: [{ type: 'text', text: clamp(JSON.stringify(payload, null, 2), maxChars, hint) }],
    isError: failed,
  };
}

/**
 * A request as a *caller* writes one: `variables` may be omitted.
 *
 * {@link GraphqlRequest} keeps `variables` required so an executor never has to
 * check for it, which is the right guarantee for the implementer but noise for
 * a custom tool running a document that takes none. {@link runExecutor} fills
 * the gap in.
 */
export type ExecutorRequest = Omit<GraphqlRequest, 'variables'> & {
  variables?: Record<string, unknown>;
};

/**
 * Runs `request` through `executor`, turning a thrown error into a GraphQL-shaped
 * `{ errors }` result.
 *
 * Executors throw for reasons that have nothing to do with the schema — the
 * endpoint is down, `fetch` rejected, a custom executor has a bug — and an
 * uncaught throw reaches the SDK, which renders the bare message as the tool's
 * text body. That body is documented as parseable JSON, so a client handling a
 * network outage would hit a `JSON.parse` failure instead of the error it came
 * for. Catching here keeps every tool result the same shape.
 *
 * @param executor - Where the operation runs.
 * @param request - The GraphQL request to run.
 */
export async function runExecutor(
  executor: GraphqlExecutor,
  request: ExecutorRequest,
): Promise<GraphqlResult> {
  try {
    return await executor({ ...request, variables: request.variables ?? {} });
  } catch (cause) {
    return { errors: [{ message: messageOf(cause) }] };
  }
}

/** A thrown value's message, falling back to its string form. */
function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text === '[object Object]' ? 'The GraphQL executor failed.' : text;
}

/**
 * Whether `data` holds anything the agent can use: at least one non-null root
 * field. `null`/absent `data` is a top-level or transport failure, and
 * `{ field: null }` — what a nullable root field yields when its resolver throws
 * — is just as empty despite being a present object.
 */
function hasUsableData(data: Record<string, unknown> | null | undefined): boolean {
  if (data === null || data === undefined) return false;
  return Object.values(data).some((value) => value !== null);
}

/**
 * Keeps the parts of a GraphQL error an agent can act on.
 *
 * Empty containers are dropped, not just absent ones: graphql-js initialises
 * `extensions` to `{}` on every `GraphQLError`, so a truthiness check alone puts
 * a useless `"extensions": {}` on every local-executor failure — the exact kind
 * of noise this function exists to remove.
 */
function condense(error: GraphqlError): GraphqlError {
  const condensed: GraphqlError = { message: error.message };
  if (error.path?.length) condensed.path = error.path;
  if (error.extensions && Object.keys(error.extensions).length) {
    condensed.extensions = error.extensions;
  }
  return condensed;
}
