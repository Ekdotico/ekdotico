// `POST /api/feedback` (FR-AU-74 to FR-AU-78; docs/contracts/feedback-intake.md, "Browser to application").
// The route checks the origin before this runs (src/app/api/feedback/route.ts). The checks here run in the
// contract's order: the switch, the session, the notice, the limits, the body, the
// delivery. Every answer is a code: no text for a reader is written here (fw-strings is open), so each error
// body carries an empty `message`. The application keeps no copy of a submission and logs only its identifier
// and the outcome, never the account (FR-AU-76, appsec rule 12).
import { describeUserAgent } from '../user-agent.ts';
import type { IntakeBody } from './client.ts';
import { MAX_REQUEST_BYTES, validateSubmission } from './validate.ts';
import type { LimitName } from '../settings.ts';

type LimitAnswer = { ok: true } | { ok: false; retryAfterSeconds: number };

/** What the route supplies: the session and the notice, the limits, the delivery, and the clock. */
export interface Dependencies {
  enabled: () => boolean;
  /** The account of the verified session; null for none. `stopped` says a session the founding-team gate stops. */
  session: (headers: Headers) => Promise<{ userId: string } | { userId: null; stopped: Response | null }>;
  noticeAcknowledged: (userId: string) => Promise<boolean>;
  checkLimit: (name: LimitName, key: string) => Promise<LimitAnswer>;
  takeLimit: (name: LimitName, key: string) => Promise<unknown>;
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
  if (session.userId === null) return session.stopped ?? refuse(401, 'unauthorised');
  const { userId } = session;
  // 3. The Closed α notice.
  if (!(await d.noticeAcknowledged(userId))) return refuse(403, 'notice_not_acknowledged');
  // 4. The limits, asked and not counted: only an accepted submission counts (fw-limit-count).
  for (const name of FEEDBACK_LIMITS) {
    const result = await d.checkLimit(name, userId);
    if (!result.ok) {
      const seconds = result.retryAfterSeconds;
      await d.limitReached(name, userId, seconds);
      return refuse(429, 'rate_limited', { retryAfterSeconds: seconds }, {}, { 'Retry-After': String(seconds) });
    }
  }
  // 5. The body.
  const parsed = await d.readJson(request, MAX_REQUEST_BYTES);
  const checked = validateSubmission(parsed);
  if (!checked.ok) {
    const { faults } = checked;
    const code = faults.some(({ rule }) => rule === 'forbidden_character') ? 'forbidden_character' : 'invalid';
    return refuse(422, code, { fields: faults });
  }
  const { value } = checked;
  // 6. The delivery. The identifier is the browser's on a retry and the server's otherwise (fw-retry-id).
  const submissionId = value.submissionId ?? d.newId();
  const accepted = await d.deliver({
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
  // The acceptance is told, and counted. A counter that cannot be written does not turn it into a failure:
  // the user would send again, and the intake would hold two.
  for (const name of FEEDBACK_LIMITS) {
    await d.takeLimit(name, userId).catch(() => d.log('feedback: limit not counted'));
  }
  return Response.json({ sent: true }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}
