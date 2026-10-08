// The channel on which the web application tells every collaboration server
// instance of a change that ends or alters open connections (NFR-SE-03 (d),
// FR-ED-40): a Valkey channel, since Valkey is what the instances share
// (NFR-SC-04). The web application publishes; each collaboration server
// subscribes (src/collab/server.ts) and acts on the connections it holds.
//
// The events are the list of FR-ED-40 and no other. Built so far: (c), the
// deletion of a document. The slices that build the others add a member to
// `CollabEvent`, a case to `readEvent`, a publish after the commit of the
// change, and a case where the collaboration server acts on an event.
//
// A notice can be lost: Valkey keeps no message for a subscriber that is not
// connected, and a publish can fail after its change was committed. The
// channel is the fast path and never the guarantee; the guarantee is the
// re-check of every open connection at least once in 60 seconds (FR-ED-41,
// NFR-SE-03 (e)), which the slice that ends and switches connections builds.
// UNTIL THEN a lost notice leaves a connection open.
//
// NFR-SE-19: a message holds the kind and identifiers of the application, and
// nothing else: no title, no content, no address. A message is read as data
// and is never obeyed for what it says: anything that reaches Valkey can
// publish one, and a genuine one can arrive after what it tells of was undone.
// It is a reason to look, and the collaboration server acts on what the
// document's row then says (src/collab/server.ts, `endDocument`).
//
// Nothing here is of Next.js.
import { Redis } from 'ioredis';
import { faultOf } from '../fault.ts';
import { settings } from '../settings.ts';
import { valkey } from '../valkey.ts';

/** One change, as it is published. A union: each event of FR-ED-40 that is built is a member. */
export type CollabEvent =
  /** FR-ED-40 (c): the document was deleted; every connection to it is closed. */
  { kind: 'document-deleted'; documentId: string };

/** The one channel. Every instance of the collaboration server subscribes to it. */
export const COLLAB_EVENTS_CHANNEL = 'ekdotico:collab-events';

// `Document.id` as the application writes it (FR-ED-35).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The event a message holds, or null for anything else: text that is not
 * JSON, a kind this version does not know (another version of the web
 * application may be running beside it during a deployment), or a field that
 * is not what its kind takes. Each field is read by name, so nothing else a
 * message carries goes further.
 */
export function readEvent(message: string): CollabEvent | null {
  let read: unknown;
  try {
    read = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof read !== 'object' || read === null) return null;
  const { kind, documentId } = read as Record<string, unknown>;
  if (kind === 'document-deleted' && typeof documentId === 'string' && UUID.test(documentId)) {
    return { kind, documentId };
  }
  return null;
}

/**
 * Publishes a change that HAS BEEN COMMITTED. It never rejects, and answers
 * whether the notice was handed to Valkey: the change stands either way, so a
 * caller neither fails its request nor undoes anything for a notice that was
 * not sent. The failure is not silent: one line, with the kind, the document's
 * identifier, and the class of the fault (NFR-SE-19). What it leaves open is
 * closed by the re-check (see the head of this file).
 */
export async function publishCollabEvent(event: CollabEvent): Promise<boolean> {
  try {
    // Written field by field, so that nothing else an object carries is sent.
    const message = JSON.stringify({ kind: event.kind, documentId: event.documentId });
    await valkey().publish(COLLAB_EVENTS_CHANNEL, message);
    return true;
  } catch (error) {
    console.error(
      `collab events: ${event.kind} not published for document ${event.documentId} (${faultOf(error)})`,
    );
    return false;
  }
}

// A subscription that was refused is asked for again after this long, then
// after twice as long each time, and never less often than the last of these.
const SUBSCRIBE_RETRY_MS = 1000;
const SUBSCRIBE_RETRY_MAX_MS = 30_000;

/** How long after the `failures`-th refusal in a row the subscription is asked for again: 1 s, 2 s, 4 s … 30 s. */
export function subscribeRetryDelay(failures: number): number {
  return Math.min(SUBSCRIBE_RETRY_MS * 2 ** (failures - 1), SUBSCRIBE_RETRY_MAX_MS);
}

/**
 * What a line says of a subscription that failed: the class of the fault, and
 * for a reply of Valkey the code word it begins with, such as `NOPERM` (the
 * ACL lacks the channel) or `NOAUTH`. The word is Valkey's own, capitals and
 * nothing else, and the rest of the reply, which names a user, is left out
 * (NFR-SE-19).
 */
function subscribeFault(error: unknown): string {
  const word =
    error instanceof Error && error.name === 'ReplyError' ? /^[A-Z]{2,16}(?= |$)/.exec(error.message) : null;
  return word ? `${faultOf(error)} ${word[0]}` : faultOf(error);
}

export interface CollabEventSubscription {
  /** Resolves when the channel is first subscribed to. It never rejects. */
  subscribed: Promise<void>;
  /** Whether the channel is subscribed to now: false until the first time, and from the loss of the connection until it is subscribed again. */
  isSubscribed: () => boolean;
  /** The connection, for the process that holds it to end, and for the tests. */
  client: Redis;
}

/**
 * Subscribes this process to the channel, on a connection of its own: a
 * Valkey connection that subscribes can send nothing else, so it cannot be
 * the one of src/lib/valkey.ts. The timeouts and the line of a fault are that
 * module's.
 *
 * The subscription is made each time the connection becomes ready, the first
 * time and after every loss of the connection (the client reconnects by
 * itself, for ever), and not by the client's own bookkeeping, which
 * resubscribes only what was once subscribed and so never recovers a first
 * attempt that failed. A subscription that fails on a ready connection drops
 * the connection, so that the next one tries again: but only after a wait of
 * this module's own (`subscribeRetryDelay`), because the client begins its
 * own waits afresh each time a connection becomes ready, and a Valkey that
 * accepts the connection and refuses the subscription, as one whose ACL lacks
 * the channel does, would otherwise be asked seven times a second for ever.
 * One line is printed for each distinct state and not for each attempt: the
 * fault when it first appears or changes, and the recovery.
 *
 * `handle` is called for each event that `readEvent` passes. What it throws,
 * or rejects with, is reported by its class and goes no further.
 */
export function subscribeCollabEvents(
  handle: (event: CollabEvent) => void | Promise<void>,
): CollabEventSubscription {
  const client = new Redis(settings().valkeyUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    commandTimeout: 5000,
    autoResubscribe: false,
  });
  client.on('error', (error) => console.error(`valkey: connection fault (${faultOf(error)})`));

  let first!: () => void;
  const subscribed = new Promise<void>((resolve) => (first = resolve));
  // How many subscriptions were refused in a row, the fault the last line
  // named, and how many were asked for in all.
  let failures = 0;
  let said: string | undefined;
  let attempts = 0;
  // Whether this connection holds the subscription: a subscription lives and
  // ends with its connection, however that ends.
  let live = false;
  client.on('close', () => (live = false));
  client.on('ready', () => {
    const attempt = ++attempts;
    client.subscribe(COLLAB_EVENTS_CHANNEL).then(
      () => {
        if (said !== undefined) console.error('collab events: subscribed again');
        failures = 0;
        said = undefined;
        // Not where the connection was ended meanwhile, by `disconnect` or `quit`.
        live = client.status === 'ready';
        first();
      },
      (error: unknown) => {
        const state = subscribeFault(error);
        if (state !== said) console.error(`collab events: not subscribed (${state})`);
        said = state;
        // unref: the wait never keeps a stopping process alive.
        setTimeout(() => {
          // Not where the connection was lost and made again meanwhile: that
          // one has asked for itself. And not after `quit` or `disconnect`: a
          // connection that was ended stays ended.
          if (attempt === attempts && client.status === 'ready') client.disconnect(true);
        }, subscribeRetryDelay(++failures)).unref();
      },
    );
  });
  client.on('message', (_channel, message) => {
    const event = readEvent(message);
    if (!event) return;
    // `handle` may throw or reject: both end here.
    new Promise<void>((resolve) => resolve(handle(event))).catch((error: unknown) => {
      console.error(
        `collab events: ${event.kind} not handled for document ${event.documentId} (${faultOf(error)})`,
      );
    });
  });
  return { subscribed, isSubscribed: () => live, client };
}
