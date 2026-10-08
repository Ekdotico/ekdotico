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
// and never trusted for more than it says: a collaboration server closes what
// it is told to close, and that is all a message can do.
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
 * not sent. The failure is not silent: one line, with the kind and the class
 * of the fault (NFR-SE-19). What it leaves open is closed by the re-check
 * (see the head of this file).
 */
export async function publishCollabEvent(event: CollabEvent): Promise<boolean> {
  try {
    // Written field by field, so that nothing else an object carries is sent.
    const message = JSON.stringify({ kind: event.kind, documentId: event.documentId });
    await valkey().publish(COLLAB_EVENTS_CHANNEL, message);
    return true;
  } catch (error) {
    console.error(`collab events: ${event.kind} not published (${faultOf(error)})`);
    return false;
  }
}

export interface CollabEventSubscription {
  /** Resolves when the channel is first subscribed to. It never rejects. */
  subscribed: Promise<void>;
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
 * the connection, so that the next one tries again.
 *
 * `handle` is called for each event that `readEvent` passes. What it throws
 * is reported by its class and goes no further.
 */
export function subscribeCollabEvents(handle: (event: CollabEvent) => void): CollabEventSubscription {
  const client = new Redis(settings().valkeyUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    commandTimeout: 5000,
    autoResubscribe: false,
  });
  client.on('error', (error) => console.error(`valkey: connection fault (${faultOf(error)})`));

  let first!: () => void;
  const subscribed = new Promise<void>((resolve) => (first = resolve));
  client.on('ready', () => {
    client.subscribe(COLLAB_EVENTS_CHANNEL).then(first, (error: unknown) => {
      console.error(`collab events: not subscribed (${faultOf(error)})`);
      // Not after `quit` or `disconnect`: a connection that was ended stays ended.
      if (client.status === 'ready') client.disconnect(true);
    });
  });
  client.on('message', (_channel, message) => {
    const event = readEvent(message);
    if (!event) return;
    try {
      handle(event);
    } catch (error) {
      console.error(`collab events: ${event.kind} not handled (${faultOf(error)})`);
    }
  });
  return { subscribed, client };
}
