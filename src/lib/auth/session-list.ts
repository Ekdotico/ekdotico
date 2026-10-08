// The list of an account's sessions and the ending of them (FR-AU-85). The two
// endpoints are the application's own inside the identity library, under the
// library's names. As they ship at 1.7.7 the library's list returns every
// session's token and network address, and its endpoint that ends one session
// names that session by its token. Here a session is named by the identifier
// of its row, which signs nothing in and is no secret between the browsers of
// one account; no answer holds a token (NFR-SE-17 (c)).
import { createAuthEndpoint } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import { db } from '../db.ts';
import { errorResponse, textFields } from '../http.ts';
import { settings } from '../settings.ts';
import { describeUserAgent } from '../user-agent.ts';
import { notAdmitted } from './route-answers.ts';
import { validateSessionRow } from './session.ts';

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const MESSAGES = {
  shape: 'The request must name one session, and nothing else.',
  notFound: 'This session has already ended. Reload the page to see the sessions that have not.',
};

/** One session as the account settings show it (FR-AU-85). */
export interface SessionView {
  id: string;
  /** When it began, and when it was last renewed: ISO 8601, UTC. */
  beganAt: string;
  renewedAt: string;
  /** The browser's name and the operating system family (FR-AU-68 (c)), where the browser named them. */
  browser: string | null;
  system: string | null;
  /** The session in use. */
  current: boolean;
}

/** The sessions that have not ended: neither period of FR-AU-84 has passed. */
const standing = (now: Date) => ({
  expiresAt: { gt: now },
  createdAt: { gt: new Date(now.getTime() - settings().sessionMaxSeconds * 1000) },
});

/**
 * FR-AU-85: "the sessions of the account that have not ended", the newest
 * first. Read without the token and without the network address, which the
 * list "does not show", so neither can reach a page by oversight.
 */
export async function listSessions(
  userId: string,
  currentSessionId: string,
  now: Date = new Date(),
): Promise<SessionView[]> {
  const rows = await db().session.findMany({
    where: { userId, ...standing(now) },
    // The library writes a row again only when it renews it, so the time of
    // the last write is the time of the last renewal, and of the beginning
    // until the first.
    select: { id: true, createdAt: true, updatedAt: true, userAgent: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    beganAt: row.createdAt.toISOString(),
    renewedAt: row.updatedAt.toISOString(),
    ...describeUserAgent(row.userAgent),
    current: row.id === currentSessionId,
  }));
}

/**
 * FR-AU-85: `POST /api/auth/revoke-session`, with `{ "id" }`: "the user can
 * end any one of them". The session in use among them, which is a sign-out.
 */
export const revokeSession = createAuthEndpoint(
  '/revoke-session',
  { method: 'POST', requireHeaders: true },
  async (ctx) => {
    // NFR-SE-17 (c): ending a session reads the row of the session that asks.
    const validation = await validateSessionRow(ctx.headers);
    const { session } = validation;
    if (!session) return notAdmitted(validation);
    const entered = textFields(ctx.body, 'id');
    if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.shape);

    // One statement, on the identifier and the account together: a session of
    // another account is not found, as one that does not exist is not, and the
    // answer is the same for both.
    // What is no identifier of the library's is not looked up at all: the
    // database refuses some of what a request can hold, and that is no fault.
    const { count } = /^[A-Za-z0-9_-]{1,64}$/.test(entered.id)
      ? await db().session.deleteMany({ where: { id: entered.id, userId: session.userId } })
      : { count: 0 };
    if (count !== 1) return errorResponse(404, 'session_not_found', MESSAGES.notFound);
    // FR-ED-40 (d): the slice that builds the collaboration server publishes
    // the end of this session here.

    // FR-AU-84: the browser whose own session it was has its cookies cleared at once.
    if (entered.id === session.sessionId) deleteSessionCookie(ctx);
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({});
  },
);

/** FR-AU-85: `POST /api/auth/revoke-other-sessions`: "all but the one in use", in one action. The body is not read. */
export const revokeOtherSessions = createAuthEndpoint(
  '/revoke-other-sessions',
  { method: 'POST', requireHeaders: true, disableBody: true },
  async (ctx) => {
    const validation = await validateSessionRow(ctx.headers);
    const { session } = validation;
    if (!session) return notAdmitted(validation);
    await db().session.deleteMany({ where: { userId: session.userId, id: { not: session.sessionId } } });
    // FR-ED-40 (d): the slice that builds the collaboration server publishes
    // the end of these sessions here.
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({});
  },
);

/**
 * NFR-RE-15: removes the rows of sessions that have ended by either period of
 * FR-AU-84; returns how many. A session ended in any other way has no row
 * already. Idempotent.
 */
export async function deleteEndedSessions(now: Date = new Date()): Promise<number> {
  const { expiresAt, createdAt } = standing(now);
  const { count } = await db().session.deleteMany({
    where: { OR: [{ expiresAt: { lte: expiresAt.gt } }, { createdAt: { lte: createdAt.gt } }] },
  });
  return count;
}
