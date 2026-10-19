// Telling the collaboration server that a session ended (FR-ED-40 (d),
// NFR-SE-03 (d)): every connection opened under it is closed within 5 seconds.
// Each place that ends a session of a user publishes this AFTER the commit of
// the change that ended it, and never before: a connection must not be closed
// for a change that was not made. The event names the user and nothing else;
// the collaboration server reads the sessions' rows and closes the connections
// whose session no longer stands, so what it does rests on the rows and not on
// the notice (src/collab/server.ts, `look`).
//
// A publish that fails is one line and never a fault of the request: the end of
// the session stands, and the re-check closes the connection within 60 seconds
// (FR-ED-41; src/lib/collab/events.ts).
import { publishCollabEvent } from '../collab/events.ts';
import { db } from '../db.ts';
import { faultOf } from '../fault.ts';

/** Publishes that a session of this user ended. It never rejects. */
export async function sessionEnded(userId: string): Promise<void> {
  await publishCollabEvent({ kind: 'session-ended', userId });
}

/**
 * Ends the session a browser held when it signed in again, by the
 * application's own client (which rejects on a fault and is quiet where the row
 * is absent: the library's deletion can skip the row without a word), and tells
 * the collaboration server. A new sign-in ends it as a sign-out would (the
 * owner's decision of 8 October 2026; register row S15-3).
 */
export async function endHeldSession(token: string): Promise<void> {
  const user = await userOfSessionToken(token);
  await db().session.deleteMany({ where: { token } });
  if (user) await sessionEnded(user);
}

/**
 * The user whose session this token is, read BEFORE the row is deleted, since
 * a deleted row names no one. Null where there is no such session, or where
 * the read fails: a read that fails is not a reason to fail the sign-out, and
 * the re-check ends the connection within 60 seconds.
 */
export async function userOfSessionToken(token: string): Promise<string | null> {
  try {
    const held = await db().session.findFirst({ where: { token }, select: { userId: true } });
    return held?.userId ?? null;
  } catch (error) {
    // One line, naming no person (NFR-SE-19): the connections of that session are closed by the re-check.
    console.error(`session end: the user of a session was not read, no notice is sent (${faultOf(error)})`);
    return null;
  }
}
