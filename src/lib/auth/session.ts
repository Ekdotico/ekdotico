// The validation of a session (NFR-SE-02, FR-AU-07, FR-AU-84). The presence of
// a cookie is never validation: a session stands only where the library has
// checked it, against its row or against the signed copy, and where the
// application has checked the 30 days the library does not know of.
//
// Nothing here is of Next.js: the collaboration server validates through
// `validateSessionRow` (NFR-SE-17 (f)).
import { db } from '../db.ts';
import { onlyReads } from '../http.ts';
import { settings } from '../settings.ts';

/** What a validated session yields, and nothing a caller does not need. */
export interface ValidSession {
  userId: string;
  sessionId: string;
}

export interface Validation {
  session: ValidSession | null;
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
  if (!response) return { session: null, setCookie: answer.getSetCookie() };

  // FR-AU-84: whatever its use, a session ends 30 days after it began. The
  // signed copy carries the time it began, so the check is made on both paths,
  // and it is written so that a time that cannot be read refuses.
  const { id, userId, createdAt } = response.session;
  const ends = new Date(createdAt).getTime() + settings().sessionMaxSeconds * 1000;
  if (!(Date.now() < ends)) {
    // Ended at once for every other reader too: the row is deleted, and the
    // library's renewed cookies are not handed on.
    await db().session.deleteMany({ where: { id } });
    return { session: null, setCookie: [] };
  }
  return { session: { userId, sessionId: id }, setCookie: answer.getSetCookie() };
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
