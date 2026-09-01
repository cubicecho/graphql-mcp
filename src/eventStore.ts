/**
 * The replay buffer behind a resumable SSE stream.
 *
 * A stateful session's whole point is the open stream: progress notifications
 * and the result of a long tool call arrive on it after the request that
 * started them has been answered. Networks being what they are, that stream
 * drops. The MCP transport's answer is the SSE `Last-Event-ID` header — the
 * client reconnects saying how far it got, and the server sends what came
 * after. That only works if something kept the events, and the SDK keeps
 * nothing on its own: without an event store it never even writes an event id,
 * so a dropped connection loses whatever was in flight rather than resuming.
 *
 * ## Why the default is in-memory, and bounded
 *
 * A replay buffer is unbounded growth wearing a useful hat: every notification
 * on every stream of every live session, kept against a reconnection that may
 * never come. So {@link MemoryEventStore} caps two things — how many events a
 * stream keeps, and how many streams one session keeps — and evicts the oldest
 * of each. A session gets its own store, so the buffers die with the session
 * that the session table was already bounding.
 *
 * The ceiling that matters is the product: `maxSessions × maxStreams ×
 * maxEventsPerStream` messages, all three of which are options.
 *
 * ## Why an evicted event is an error rather than a silent gap
 *
 * {@link MemoryEventStore.getStreamIdForEventId} reports an aged-out event id as
 * unknown, which the transport answers with a 400. The alternative — replaying
 * the events that *are* left — would hand the client a stream it believes is
 * continuous and is not, and there is nothing downstream that could notice. A
 * client told its resume point is gone can start a fresh stream; one told
 * nothing cannot.
 *
 * ## Bringing your own
 *
 * Replay across replicas or restarts needs storage this package has no business
 * choosing, so {@link ReplayOption} also takes a factory returning any
 * {@link EventStore} — Redis, a Durable Object, a database. The interface is
 * modelled here rather than imported so it holds across the whole peer range.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Identifies one SSE stream within a session. Minted by the transport. */
export type StreamId = string;
/** Identifies one event within a stream — what a client sends as `Last-Event-ID`. */
export type EventId = string;

/**
 * Storage for events written to an SSE stream, so a reconnecting client can be
 * caught up from the last id it saw.
 *
 * Structurally identical to the SDK's `EventStore`, declared here so this
 * package's public types don't move with the SDK's export surface.
 */
export interface EventStore {
  /**
   * Records one event and returns the id the transport will write as the SSE
   * `id:` field.
   */
  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;
  /**
   * Which stream an event id belongs to, or `undefined` if the store no longer
   * knows — which the transport reports to the client rather than guessing.
   */
  getStreamIdForEventId?(eventId: EventId): Promise<StreamId | undefined>;
  /**
   * Sends every event recorded after `lastEventId`, in order, and returns the
   * stream they belong to.
   */
  replayEventsAfter(
    lastEventId: EventId,
    handlers: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId>;
}

/** Bounds for a {@link MemoryEventStore}. */
export interface ReplayOptions {
  /**
   * Events one stream keeps before the oldest is dropped. Default `64`. This is
   * the reconnect window: a client that misses more than this while
   * disconnected cannot resume and must start a new stream.
   */
  maxEventsPerStream?: number;
  /**
   * Streams one session keeps buffers for, least-recently-written evicted
   * first. Default `4`. A session has one standalone stream plus one per
   * in-flight request, so the cap only bites on a session with many concurrent
   * calls — where the oldest is also the least likely to be resumed.
   */
  maxStreams?: number;
}

/**
 * How a stateful session buffers events for replay.
 *
 * `true` (the default) gives each session its own bounded
 * {@link MemoryEventStore}; an options object tunes those bounds; `false` turns
 * resumability off entirely, which is what the SDK does on its own; and a
 * factory hands back a store of your own, called once per session.
 */
export type ReplayOption = boolean | ReplayOptions | (() => EventStore);

/** Events one stream keeps by default. */
export const DEFAULT_MAX_EVENTS_PER_STREAM = 64;
/** Streams one session keeps buffers for by default. */
export const DEFAULT_MAX_STREAMS = 4;

/**
 * A bounded, in-process replay buffer: one array of events per stream, oldest
 * dropped first, with a cap on the streams themselves.
 *
 * Per session, not per process. Two sessions never replay each other's events,
 * and a session's buffers are released when it is.
 */
export class MemoryEventStore implements EventStore {
  private readonly streams = new Map<StreamId, Array<{ id: EventId; message: JSONRPCMessage }>>();
  /** Reverse index, so an id resolves to its stream without scanning them all. */
  private readonly streamOf = new Map<EventId, StreamId>();
  private readonly maxEventsPerStream: number;
  private readonly maxStreams: number;
  private counter = 0;

  constructor(options: ReplayOptions = {}) {
    this.maxEventsPerStream = options.maxEventsPerStream ?? DEFAULT_MAX_EVENTS_PER_STREAM;
    this.maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
  }

  /** Events currently buffered across every stream. */
  get size(): number {
    let total = 0;
    for (const events of this.streams.values()) total += events.length;
    return total;
  }

  /** Streams currently holding a buffer. */
  get streamCount(): number {
    return this.streams.size;
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const id = String(++this.counter);
    const events = this.open(streamId);
    events.push({ id, message });
    this.streamOf.set(id, streamId);
    while (events.length > this.maxEventsPerStream) {
      const dropped = events.shift();
      if (dropped) this.streamOf.delete(dropped.id);
    }
    return id;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.streamOf.get(eventId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const streamId = this.streamOf.get(lastEventId);
    // The transport asks `getStreamIdForEventId` first and stops on a miss, so
    // reaching here with an unknown id means a caller drove the store directly.
    // Returning a made-up stream id would map the client's new connection to a
    // stream nothing writes to, so say so instead.
    if (streamId === undefined) throw new Error(`graphql-mcp: unknown event id '${lastEventId}'`);
    const events = this.streams.get(streamId) ?? [];
    const after = events.findIndex((event) => event.id === lastEventId) + 1;
    for (const event of events.slice(after)) await send(event.id, event.message);
    return streamId;
  }

  /** Drops every buffer. */
  clear(): void {
    this.streams.clear();
    this.streamOf.clear();
  }

  /**
   * The buffer for a stream, created if new and marked as just-written either
   * way — `Map` iteration order is insertion order, so re-inserting keeps the
   * first entry the least-recently-written one to evict.
   */
  private open(streamId: StreamId): Array<{ id: EventId; message: JSONRPCMessage }> {
    const existing = this.streams.get(streamId);
    if (existing) {
      this.streams.delete(streamId);
      this.streams.set(streamId, existing);
      return existing;
    }
    while (this.streams.size >= this.maxStreams) {
      const oldest = this.streams.keys().next();
      if (oldest.done) break;
      this.forget(oldest.value);
    }
    const events: Array<{ id: EventId; message: JSONRPCMessage }> = [];
    this.streams.set(streamId, events);
    return events;
  }

  /** Drops a stream's buffer and every id that pointed into it. */
  private forget(streamId: StreamId): void {
    for (const event of this.streams.get(streamId) ?? []) this.streamOf.delete(event.id);
    this.streams.delete(streamId);
  }
}

/**
 * Turns a {@link ReplayOption} into a per-session factory.
 *
 * Returns a function rather than a store because each session needs its own:
 * one shared buffer would let a session's reconnect replay another's events,
 * and would outlive every session that filled it. A caller-supplied factory is
 * free to hand back the same store each time if its own keying makes that safe.
 */
export function eventStoreFactory(option: ReplayOption = true): () => EventStore | undefined {
  if (option === false) return () => undefined;
  if (typeof option === 'function') return option;
  const bounds = option === true ? {} : option;
  return () => new MemoryEventStore(bounds);
}
