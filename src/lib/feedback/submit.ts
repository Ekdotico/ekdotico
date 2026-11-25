// `POST /api/feedback` (FR-AU-74 to FR-AU-78; docs/contracts/feedback-intake.md, "Browser to application").
// The route checks the origin before this runs (src/app/api/feedback/route.ts). The checks here run in the
// contract's order: the switch, the session, the notice, the limits, the body, the
// delivery. Every answer is a code: no text for a reader is written here (fw-strings (D482), fw-refused-text), so each error
// body carries an empty `message`. The application keeps no copy of a submission and logs only its identifier
// and the outcome, never the account (FR-AU-76, appsec rule 12).
import { describeUserAgent } from '../user-agent.ts';
import type { IntakeBody } from './client.ts';
import { MAX_REQUEST_BYTES, validateSubmission, type Kind } from './validate.ts';
import type { LimitName } from '../settings.ts';

type Reservation = { ok: true; giveBack: () => Promise<void> } | { ok: false; retryAfterSeconds: number };

/** What the route supplies: the session and the notice, the limits, the delivery, and the clock. */
export interface Dependencies {
  enabled: () => boolean;
  /** The account of the verified session; otherwise the answer of the other routes (`notAdmitted`): 401, or 403 for a session the founding-team gate stops. */
  session: (headers: Headers) => Promise<{ userId: string } | { userId: null; denied: Response }>;
  noticeAcknowledged: (userId: string) => Promise<boolean>;
  /** FR-AU-95: whether the account has acknowledged the current version of the feedback notice. */
  feedbackNoticeAcknowledged: (userId: string) => Promise<boolean>;
  /**
   * FR-AU-94: called once, after the intake accepted a submission, with what may be posted to Discord. The route
   * schedules the post after the response; whatever this does or throws, the answer to the user is the same.
   */
  accepted: (submission: { submissionId: string; kind: Kind; message: string }) => void;
  /** Takes one place of the limit now, to be given back (`takeLimitReturnable`). */
  reserve: (name: LimitName, key: string) => Promise<Reservation>;
  /** Null where the account may still send; otherwise the answer of a signed-out caller (its deletion is confirmed). */
  stillAllowed: (userId: string) => Promise<Response | null>;
  /** Writes the entry of a limit reached (NFR-SE-19). */
  limitReached: (name: LimitName, userId: string, seconds: number) => Promise<void>;
  readJson: (request: Request, maxBytes: number) => Promise<unknown>;
  deliver: (body: IntakeBody) => Promise<boolean>;
  appVersion: string;
  now: () => Date;
  newId: () => string;
  log: (line: string) => void;
}

/** The limits of FR-AU-78: both settings apply, 5 in any 10 minutes and 30 in any 24 hours. */
export const FEEDBACK_LIMITS: readonly LimitName[] = ['FEEDBACK_SHORT_PER_USER', 'FEEDBACK_DAY_PER_USER'];

// `inside` goes in `error` (`fields`, `retryAfterSeconds`), `beside` next to it (`submissionId`).
function refuse(
  status: number,
  code: string,
  inside: Record<string, unknown> = {},
  beside: Record<string, unknown> = {},
  headers?: Record<string, string>,
) {
  return Response.json(
    { error: { code, message: '', ...inside }, ...beside },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } },
  );
}

// The major version of the browser the header names, from the name's own token. Null where it is not found.
const VERSION: Record<string, RegExp> = {
  Edge: /\bEdg(?:e|A|iOS)?\/(\d+)/,
  Opera: /\b(?:OPR|Opera)\/(\d+)/,
  Firefox: /\b(?:Firefox|FxiOS)\/(\d+)/,
  Chrome: /\b(?:Chrome|CriOS|Chromium)\/(\d+)/,
  Safari: /\bVersion\/(\d+)/,
};

/** FR-AU-68 (c): the name, the major version and the system family, from names the application lists only. */
export function browserOf(userAgent: string | null): IntakeBody['browser'] {
  const { browser, system } = describeUserAgent(userAgent);
  const major = browser ? Number(VERSION[browser]?.exec((userAgent ?? '').slice(0, 512))?.[1]) : NaN;
  return {
    name: browser ?? 'unknown',
    major: Number.isInteger(major) && major <= 9999 ? major : null,
    osFamily: system ?? 'unknown',
  };
}

export async function handleFeedback(request: Request, d: Dependencies): Promise<Response> {
  // 1. The switch: closed, as a route that does not exist.
  if (!d.enabled()) return refuse(404, 'not_found');
  // 2. A signed-in session.
  const session = await d.session(request.headers);
  if (session.userId === null) return session.denied;
  const { userId } = session;
  // 3. The Closed α notice.
  if (!(await d.noticeAcknowledged(userId))) return refuse(403, 'notice_not_acknowledged');
  // 3b. The feedback notice of FR-AU-95, for the version now current. Not stated in FR-AU-95: assumed (see the pull request).
  if (!(await d.feedbackNoticeAcknowledged(userId))) return refuse(403, 'feedback_notice_not_acknowledged');
  // 4. The limits. A place is taken before anything is sent, so that a burst cannot read "0 of 5" together and
  // be accepted together, and is given back on every path that does not end in an accepted send, a thrown error
  // included: so only an accepted submission stays counted (fw-limit-count).
  const held: (() => Promise<void>)[] = [];
  let accepted = false;
  try {
    for (const name of FEEDBACK_LIMITS) {
      const place = await d.reserve(name, userId);
      if (!place.ok) {
        const seconds = place.retryAfterSeconds;
        await d.limitReached(name, userId, seconds);
        return refuse(
          429,
          'rate_limited',
          { retryAfterSeconds: seconds },
          {},
          { 'Retry-After': String(seconds) },
        );
      }
      held.push(place.giveBack);
    }
    // 5. The body.
    const parsed = await d.readJson(request, MAX_REQUEST_BYTES);
    const checked = validateSubmission(parsed);
    if (!checked.ok) {
      const { faults } = checked;
      const code = faults.some(({ rule }) => rule === 'forbidden_character')
        ? 'forbidden_character'
        : 'invalid';
      return refuse(422, code, { fields: faults });
    }
    const { value } = checked;
    // The deletion of the account may have been confirmed since the session was read (FR-AU-79): the body and the
    // limits take time. Asked again just before the send, and refused as a signed-out caller is.
    const gone = await d.stillAllowed(userId);
    if (gone) return gone;
    // 6. The delivery. The identifier is the browser's on a retry and the server's otherwise (fw-retry-id).
    const submissionId = value.submissionId ?? d.newId();
    accepted = await d.deliver({
      submissionId,
      submittedAt: d.now().toISOString(),
      kind: value.kind,
      message: value.message,
      route: value.route,
      appVersion: d.appVersion,
      browser: browserOf(request.headers.get('user-agent')),
      viewport: value.viewport,
      accountId: userId,
    });
    if (!accepted) {
      d.log(`feedback ${submissionId}: not sent`);
      return refuse(502, 'not_sent', {}, { submissionId });
    }
    d.log(`feedback ${submissionId}: sent`);
    try {
      d.accepted({ submissionId, kind: value.kind, message: value.message });
    } catch {
      d.log(`feedback ${submissionId}: not posted to discord (error)`);
    }
    return Response.json({ sent: true }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } finally {
    if (!accepted) {
      for (const giveBack of held) await giveBack().catch(() => d.log('feedback: place not given back'));
    }
  }
}
