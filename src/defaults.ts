/**
 * Every tunable in the package: a value someone chose where a different choice
 * would still be a working server. Values only, so this module runs no code.
 */

import type { NullBranches } from './zodSchema.ts';

/** Object levels a selection descends. The selection, its operation and the output schema share it. */
export const DEFAULT_SELECTION_DEPTH = 2;

/** Levels of optional expansion an argument example may use. */
export const DEFAULT_EXAMPLE_DEPTH = 3;

/** The mode a nullable input position takes when nothing says otherwise. */
export const DEFAULT_NULL_BRANCHES: NullBranches = 'always';

/** Characters a tool result may hold before it is truncated. */
export const DEFAULT_MAX_CHARS = 50_000;

/** Matches the `search` meta tool returns when the caller gives no limit. */
export const DEFAULT_SEARCH_LIMIT = 50;

/** Events one stream keeps for replay. */
export const DEFAULT_MAX_EVENTS_PER_STREAM = 64;

/** Streams one session keeps replay buffers for. */
export const DEFAULT_MAX_STREAMS = 4;

/** Milliseconds a `MemorySessionDirectory` claim lasts without a refresh: ten minutes. */
export const DEFAULT_CLAIM_TTL_MS = 600_000;

/** Milliseconds a session may sit unused before it is evicted: five minutes. */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** Sessions held at once. */
export const DEFAULT_MAX_SESSIONS = 1000;
