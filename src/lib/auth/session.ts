// The validation of a session (NFR-SE-02, FR-AU-07, FR-AU-84). The presence of
// a cookie is never validation: a session stands only where the library has
// checked it, against its row or against the signed copy, and where the
// application has checked the 30 days the library does not know of.
//
// Nothing here is of Next.js: the collaboration server validates through
// `validateSessionRow` (NFR-SE-17 (f)).
import { inDeletion } from '../account/in-deletion.ts';
import { db } from '../db.ts';
import { onlyReads } from '../http.ts';
import { settings } from '../settings.ts';
import { stoppedByFoundingGate } from './founding-gate.ts';

/** What a validated session yields, and nothing a caller does not need. */
export interface ValidSession {
  userId: string;
  sessionId: string;
}

export interface Validation {
  /**
   * The session, where the request may use the application under it. Null for
   * no session, and null for the session of an account that the
   * founding-team gate stops (FR-AU-83): a caller that reads this field alone
   * refuses such an account, which is what every caller but three is to do.
   */
  session: ValidSession | null;
  /**
   * FR-AU-83: the valid session of an account of the founding team that has
   * not turned two-factor authentication on, which "cannot use the
   * application". Read by the proxy, by the signed-in layout, which shows the
   * enrolment in place of every page, and by the endpoints of the enrolment
   * itself; by nothing else. A route answers it 403 through `notAdmitted`
   * (route-answers.ts).
   */
  stopped: ValidSession | null;
  /**
   * The `Set-Cookie` headers the library asks for: a renewed expiry, a fresh
   * signed copy, or the clearing of the cookies of a session that has ended.
   * The proxy hands them to the browser; every other caller ignores them.
   */
  setCookie: readonly string[];
}

async function validate(headers: Headers, readRow: boolean): Promise<Validation> {
  // Loaded here and not at the head of the file: the application's own
  // endpoints inside the library validate through this module (password.ts,
  // session-list.ts), and auth.ts mounts them. A static import would close
  // that circle, and whichever of the modules was loaded first would be read
  // by the others before it had a value.
  const { auth } = await import('./auth.ts');
  // The library tests the 7 days (it refuses and deletes an expired session)
  // and renews. With `disableCookieCache` it reads the row; without, it may
  // answer from the signed copy, which is at most `cookieCacheSeconds` old.
  const { response, headers: answer } = await auth().api.getSession({
    headers,
    query: readRow ? { disableCookieCache: true } : undefined,
    returnHeaders: true,
  });
  if (!response) return { session: null, stopped: null, setCookie: answer.getSetCookie() };

  // FR-AU-84: whatever its use, a session ends 30 days after it began. The
  // signed copy carries the time it began, so the check is made on both paths,
  // and it is written so that a time that cannot be read refuses.
  const { id, userId, createdAt } = response.session;
  // An answer without its two identifiers is no session (NFR-SE-02). It is
  // refused before the deletion below, which would otherwise be handed an
  // undefined `id`, and that deletes every session there is.
  if (typeof id !== 'string' || typeof userId !== 'string') {
    return { session: null, stopped: null, setCookie: [] };
  }
  const ends = new Date(createdAt).getTime() + settings().sessionMaxSeconds * 1000;
  if (!(Date.now() < ends)) {
    // Ended at once for every other reader too: the row is deleted, and the
    // library's renewed cookies are not handed on.
    await db().session.deleteMany({ where: { id } });
    return { session: null, stopped: null, setCookie: [] };
  }
  const own = { userId, sessionId: id };
  const setCookie = answer.getSetCookie();
  // FR-AU-83: the list "is evaluated at each sign-in and at each request", so
  // here, where every request is validated: the proxy, each route, each page,
  // and the collaboration server. The gate reads the account as the library
  // answered it with the session, which costs no read of its own: the row
  // for a request that changes state, and for one that only reads the signed
  // copy, at most `cookieCacheSeconds` old (NFR-SE-17 (c)). An account of the
  // team cannot turn two-factor authentication off, so a copy never shows it
  // on where the row has it off; the browser that turns it on is given a
  // fresh copy by that answer (two-factor.ts). An answer in which any of the
  // three fields is absent or of another type is one that the gate stops,
  // whoever the account is: the gate itself would take a missing address or a
  // missing verification for an account that is not of the team, and let it
  // through (NFR-SE-06 A10: never to a permissive default).
  const { email, emailVerified, twoFactorEnabled } = response.user as Record<string, unknown>;
  const stops =
    typeof email !== 'string' ||
    typeof emailVerified !== 'boolean' ||
    typeof twoFactorEnabled !== 'boolean' ||
    stoppedByFoundingGate({ email, emailVerified, twoFactorEnabled });
  // FR-AU-58 (a): from the confirmation of its deletion "the account can make
  // no further request other than those of this deletion", and there is no
  // other: the confirmation is the one request, and the steps are the timer's.
  // So the account has no session here, for the proxy, for each route, for each
  // page and for the collaboration server (401, the owner's answer to Q8). Read
  // from the table on every request, the signed copy included: it is up to a
  // minute old, and the confirmation must hold from its commit. A session of
  // the account is not ended here: step (d) ends them all.
  // No cookie is handed on: the library's renewal would keep a copy alive for an account that has none.
  if (await inDeletion(userId)) return { session: null, stopped: null, setCookie: [] };
  return stops ? { session: null, stopped: own, setCookie } : { session: own, stopped: null, setCookie };
}

/**
 * Inside a transaction, holds the row of the session to the commit: from here
 * no other request can end it, and one that already has is found (FR-AU-84:
 * a session that has ended changes nothing). False where it has ended. Prisma
 * has no read that locks a row, so the row is written with its own value.
 */
export async function holdSession(
  tx: Pick<ReturnType<typeof db>, 'session'>,
  own: ValidSession,
): Promise<boolean> {
  const where = { id: own.sessionId, userId: own.userId };
  const held = await tx.session.findFirst({ where, select: { updatedAt: true } });
  if (!held) return false;
  const locked = await tx.session.updateMany({
    where: { ...where, updatedAt: held.updatedAt },
    data: { updatedAt: held.updatedAt },
  });
  if (locked.count === 1) return true;
  // A row that is there but was renewed between the two statements is a fault, not an end.
  if ((await tx.session.count({ where })) === 0) return false;
  throw new Error('session: renewed meanwhile');
}

/**
 * The rule of NFR-SE-02: a request that only reads may be validated against
 * the signed copy; every other request reads the session's row.
 */
export function validateSession(method: string, headers: Headers): Promise<Validation> {
  return validate(headers, !onlyReads(method));
}

/**
 * Always reads the session's row. For the requests that read it although they
 * are a GET, the draft export and the issue of an image link among them
 * (NFR-SE-17 (c)), and for the collaboration server, which never uses the copy.
 */
export function validateSessionRow(headers: Headers): Promise<Validation> {
  return validate(headers, true);
}
