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
 * - **Results are clamped, structurally.** A tool that returns a large collection
 *   would otherwise flood the agent's context with no warning. What gets cut is
 *   *rows*, never members of the envelope: {@link toCallToolResult} drops
 *   elements from the arrays inside `data` until the serialized whole fits, and
 *   records what went in a `truncated` member. Slicing the serialized string
 *   instead — which is what {@link clamp} does, and all this used to do — cuts
 *   mid-token and leaves something that is not JSON, and cuts from the end,
 *   where `errors` and the partial-result `note` live. A partial failure whose
 *   diagnostics were truncated away is reported as a clean success, which is
 *   worse than reporting nothing. The `truncated` record carries a pagination
 *   hint when the field has an argument to page with, since "this was cut" on
 *   its own leaves an agent with no move but to re-run the identical call.
 *
 * A {@link toCallToolResult} body is always parseable JSON — which is also why
 * {@link runExecutor} exists: an executor that *throws* would otherwise reach
 * the SDK, which reports the bare message as text and breaks that promise on
 * exactly the failure a client most needs to handle. `guardToolArguments`
 * (`handlers.ts`) closes the other way in: the SDK rejects a call whose
 * `arguments` don't match the registered schema *before* any of this runs, and
 * reports that the same bare way. ({@link text} bodies are
 * prose — SDL printouts and search hits — and {@link clamp} slices those by
 * character, which is right for prose and only for prose.)
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GraphqlError, GraphqlExecutor, GraphqlRequest, GraphqlResult } from './types.ts';

/** Default character budget for a tool result before truncation. */
export const DEFAULT_MAX_CHARS = 50_000;

/**
 * Truncates `value` to `maxChars`, appending a note that says how much was cut
 * and what to do about it.
 *
 * For **prose** bodies only (see {@link text}). This slices by character, so
 * applying it to serialized JSON cuts mid-token and yields something no client
 * can parse; {@link toCallToolResult} drops array elements from `data` instead.
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
 * What a result's `truncated` member says when `data` did not fit the budget.
 *
 * Counted in *array elements* anywhere under `data`, since that is the unit
 * actually dropped: a row of a collection, or a member of a nested list.
 */
export interface TruncationRecord {
  /** How many array elements were dropped. Absent when `data` went entirely. */
  droppedItems?: number;
  /** How many there were before dropping. */
  totalItems: number;
  /** Set when nothing could be kept and `data` was left out altogether. */
  dataOmitted?: true;
  /** What the agent can do about it, including any pagination hint. */
  advice: string;
}

const PARTIAL_NOTE =
  'Partial result: some fields failed and are null in `data`; the rest is valid. See `errors`.';

/**
 * Wraps a GraphQL result as an MCP tool result.
 *
 * `isError` is set only when no data came back, so a partial result stays usable
 * — it carries a `note` explaining that some fields failed. Errors are condensed
 * to `message`/`path`/`extensions`.
 *
 * Over `maxChars`, rows are dropped from the arrays inside `data` until the
 * whole serialization fits, and a `truncated` member says what went. The
 * envelope itself is never cut, so the body stays parseable and `errors`/`note`
 * survive whatever happens to `data` — see the module docs.
 *
 * @param result - The executor's GraphQL result.
 * @param maxChars - Character budget before truncation.
 * @param hint - Optional advice added to the `truncated` record — {@link paginationHint}
 *   supplies one naming the field's paging argument.
 */
export function toCallToolResult(
  result: GraphqlResult,
  maxChars = DEFAULT_MAX_CHARS,
  hint?: string,
): CallToolResult {
  const errors = result.errors ?? [];
  const hasData = hasUsableData(result.data);
  const failed = errors.length > 0 && !hasData;

  /** The envelope around whatever `data` survived, serialized. */
  const envelope = (data: unknown, truncated?: TruncationRecord): string => {
    const payload: Record<string, unknown> = {};
    if (data !== undefined) payload.data = data;
    if (errors.length) payload.errors = errors.map(condense);
    if (errors.length && hasData) payload.note = PARTIAL_NOTE;
    if (truncated) payload.truncated = truncated;
    return JSON.stringify(payload, null, 2);
  };

  const whole = envelope(result.data);
  const body = whole.length <= maxChars ? whole : shrink(envelope, result.data, maxChars, hint);
  return { content: [{ type: 'text', text: body }], isError: failed };
}

/**
 * Fits the envelope into `maxChars` by dropping array elements from `data`.
 *
 * Every array under `data` is capped at the same number of elements, and the
 * largest cap that fits is found by bisection — a handful of serializations
 * rather than one per row. Capping uniformly rather than draining the biggest
 * array first keeps the result *shaped* like the one that was asked for: an
 * agent that sees three of a hundred rows in each of two collections can reason
 * about both, where one full collection and one empty one reads as though the
 * second returned nothing.
 *
 * If not even an empty `data` fits, `data` is left out entirely — an honest
 * "too large to return" with the errors still attached, rather than a body cut
 * into something unparseable. Should the diagnostics alone exceed the budget,
 * validity wins and the budget is missed: a `CallToolResult` a client cannot
 * parse is worse than one that is longer than intended.
 */
function shrink(
  envelope: (data: unknown, truncated?: TruncationRecord) => string,
  data: unknown,
  maxChars: number,
  hint?: string,
): string {
  const advice = `narrow the query or request fewer fields${hint ? `. ${hint}` : ''}`;
  const totalItems = countItems(data);

  let low = 0;
  let high = longestArray(data);
  let best: string | undefined;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const counter = { dropped: 0 };
    const capped = capArrays(data, keep, counter);
    // A cap that drops nothing yields the oversized body we already rejected.
    const candidate = counter.dropped
      ? envelope(capped, { droppedItems: counter.dropped, totalItems, advice })
      : envelope(capped);
    if (candidate.length <= maxChars && counter.dropped) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return best ?? envelope(undefined, { dataOmitted: true, totalItems, advice });
}

/** `value` with every array under it cut to `keep` elements, counting what went. */
function capArrays(value: unknown, keep: number, counter: { dropped: number }): unknown {
  if (Array.isArray(value)) {
    counter.dropped += Math.max(0, value.length - keep);
    return value.slice(0, keep).map((item) => capArrays(item, keep, counter));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, capArrays(item, keep, counter)]),
    );
  }
  return value;
}

/** Total array elements anywhere under `value` — the unit {@link capArrays} drops. */
function countItems(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + countItems(item), value.length);
  }
  if (isPlainObject(value)) {
    return Object.values(value).reduce<number>((total, item) => total + countItems(item), 0);
  }
  return 0;
}

/** The longest array anywhere under `value` — the upper bound for the bisection. */
function longestArray(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (longest, item) => Math.max(longest, longestArray(item)),
      value.length,
    );
  }
  if (isPlainObject(value)) {
    return Object.values(value).reduce<number>(
      (longest, item) => Math.max(longest, longestArray(item)),
      0,
    );
  }
  return 0;
}

/**
 * Whether `value` is a JSON object rather than an array or a scalar. A GraphQL
 * result is plain JSON, so a prototype check would be ceremony — but a custom
 * executor can return anything, and walking a `Date` or a class instance field
 * by field would rewrite it into something the caller never returned.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
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
