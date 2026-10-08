/**
 * Every tunable in the package: a value someone chose where a different choice
 * would still be a working server. Each group is frozen, so a default cannot be changed at run time.
 */

import { NullBranches } from './types.ts';

/** How a generated tool is built when its options say nothing. */
export const TOOL_DEFAULTS: Readonly<{
  /** Object levels a selection descends. The selection, its operation and the output schema share it. */
  selectionDepth: number;
  /** Levels of optional expansion an argument example may use. */
  exampleDepth: number;
  /** The mode a nullable input position takes. */
  nullBranches: NullBranches;
}> = Object.freeze({ selectionDepth: 2, exampleDepth: 3, nullBranches: NullBranches.always });

/** Limits on a tool result. */
export const RESULT_DEFAULTS: Readonly<{
  /** Characters a tool result may hold before it is truncated. */
  maxChars: number;
}> = Object.freeze({ maxChars: 50_000 });

/** Limits on the `search` meta tool. */
export const SEARCH_DEFAULTS: Readonly<{
  /** Matches returned when the caller gives no limit. */
  limit: number;
}> = Object.freeze({ limit: 50 });

/** Limits on the replay buffer behind a resumable stream. */
export const REPLAY_DEFAULTS: Readonly<{
  /** Events one stream keeps for replay. */
  maxEventsPerStream: number;
  /** Streams one session keeps replay buffers for. */
  maxStreams: number;
}> = Object.freeze({ maxEventsPerStream: 64, maxStreams: 4 });

/** Limits on stateful HTTP sessions. */
export const SESSION_DEFAULTS: Readonly<{
  /** Milliseconds a `MemorySessionDirectory` claim lasts without a refresh: ten minutes. */
  claimTtlMs: number;
  /** Milliseconds a session may sit unused before it is evicted: five minutes. */
  idleTimeoutMs: number;
  /** Sessions held at once. */
  maxSessions: number;
}> = Object.freeze({ claimTtlMs: 600_000, idleTimeoutMs: 300_000, maxSessions: 1000 });
