// What the Feedback Widget's screen decides, apart from the screen (FR-AU-59 to FR-AU-80; docs/contracts/feedback-intake.md,
// "The answers"). Pure, so that a test can pin it: no request, no clock, no React.
//
// The widget shows only sentences the owner approved, chosen by the code of an answer (fw-refused-text). The `message` of
// an error body is never read here.
import { codePoints, hasRefusedCharacter, MAX_MESSAGE_CODE_POINTS, type Kind } from './validate.ts';

/** The approved sentences, verbatim (fw-strings, fw-refused-text; FR-AU-60, 65, 77, 80). Each is pinned whole by a test. */
export const WIDGET_TEXT = {
  control: 'Send feedback',
  title: 'Send feedback',
  close: 'Close',
  legend: 'Kind of feedback',
  kinds: { problem: 'Problem', idea: 'Idea', other: 'Other' } satisfies Record<Kind, string>,
  label: 'Message',
  send: 'Send feedback',
  sending: 'Sending feedback…',
  noKind: 'Choose a kind of feedback.',
  empty: 'Write a message before you send.',
  refusedCharacter:
    'Your message contains a hidden character that cannot be sent. Type the message again, or paste it as plain text, then send it.',
  sent: 'Your feedback was sent to the Ekdotico team.',
  notSent: 'Your feedback was not sent. Your message is still here. Send it again, or try later.',
  privacyLink: 'Privacy notice',
} as const;

/** FR-AU-72, verbatim. Followed by the link of `privacyLink`. */
export const NOTICE =
  'Your message goes to the Ekdotico team. With it, Ekdotico sends the kind of page you are on, the Ekdotico version, your browser and its window size, and your account identifier. The content of your documents is not sent. Leave out of the message anything you do not want the team to read. Feedback is kept until 12 months after the last Closed α release.';

/** The public page the link leads to. Built in another slice; the control is hidden behind the switch until then. */
export const PRIVACY_HREF = '/privacy';

/** The count, in words (fw-strings). */
export function countText(remaining: number): string {
  const noun = (n: number) => (n === 1 ? 'character' : 'characters');
  return remaining >= 0
    ? `${remaining} ${noun(remaining)} remaining`
    : `${-remaining} ${noun(-remaining)} over the limit`;
}

/**
 * {time} (fw-time-format): a clock time in the person's own time zone, 24-hour, as "14:32". Rounded up to the next whole
 * minute, so that the time shown is never before the send is allowed. No date: for the daily limit it may fall on the next day.
 */
export function clockTime(retryAfterSeconds: number, now: Date, timeZone?: string): string {
  const until = new Date(Math.ceil((now.getTime() + retryAfterSeconds * 1000) / 60_000) * 60_000);
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(until);
}

/** Too long (fw-strings): `over` is how many code points are past 4,000. */
export function tooLongText(over: number): string {
  return `The message is ${over} characters over the limit of 4,000. Shorten it and send it again.`;
}

/** Too many sent (fw-strings). `time` is the format of {time}, which the owner has not yet approved. */
export function rateLimitedText(time: string): string {
  return `You have sent too much feedback for now. Your message is still here. Send it again after ${time}.`;
}

/** Characters remaining in code points, of the message as it will be counted: after leading and trailing white space (FR-AU-66). */
export function remainingOf(message: string): number {
  return MAX_MESSAGE_CODE_POINTS - codePoints(message.trim());
}

export type KindFault = 'no_kind';
export type MessageFault = 'empty' | 'too_long' | 'forbidden_character';
export interface Faults {
  kind?: KindFault;
  message?: MessageFault;
}

/** The browser's own check, the same rules in the same order as the server's. The server decides (fw-refused-set). */
export function checkInput(kind: Kind | null, message: string): Faults {
  const faults: Faults = {};
  if (kind === null) faults.kind = 'no_kind';
  if (hasRefusedCharacter(message)) faults.message = 'forbidden_character';
  else if (message.trim() === '') faults.message = 'empty';
  else if (remainingOf(message) < 0) faults.message = 'too_long';
  return faults;
}

/** What the screen shows for what came back. Never the server's own text. */
export type Outcome =
  | { kind: 'sent' }
  | { kind: 'not_sent'; submissionId?: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'faults'; faults: Faults };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * An answer of `POST /api/feedback` as a screen state. Only `201` with `sent` exactly true is success (FR-AU-75). A 422 the
 * browser's own check should have caught is shown as the fault it names; every other answer, an answer that cannot be
 * read, and no answer at all are one outcome: not sent (FR-AU-77). The identifier of a 502 is kept for the second attempt.
 */
export function outcomeOf(status: number | null, body: unknown): Outcome {
  const answer = record(body);
  const error = record(answer?.error);
  if (status === 201 && answer?.sent === true) return { kind: 'sent' };
  if (status === 429 && error?.code === 'rate_limited') {
    const seconds = error.retryAfterSeconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0)
      return { kind: 'rate_limited', retryAfterSeconds: Math.ceil(seconds) };
  }
  if (status === 422 && Array.isArray(error?.fields)) {
    const faults: Faults = {};
    for (const entry of error.fields) {
      const fault = record(entry);
      if (fault?.field === 'message') {
        if (fault.rule === 'forbidden_character') faults.message = 'forbidden_character';
        else if (fault.rule === 'empty' || fault.rule === 'required') faults.message ??= 'empty';
        else if (fault.rule === 'too_long') faults.message ??= 'too_long';
      } else if (fault?.field === 'kind' && (fault.rule === 'required' || fault.rule === 'format')) {
        faults.kind = 'no_kind';
      }
    }
    if (faults.kind || faults.message) return { kind: 'faults', faults };
  }
  const id = answer?.submissionId;
  if (status === 502 && typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))
    return { kind: 'not_sent', submissionId: id };
  return { kind: 'not_sent' };
}

/** What a failed send leaves: the identifier the server issued and what it was issued for (fw-retry-id, fw-retry-edit). */
export interface Attempt {
  submissionId: string;
  kind: Kind;
  message: string;
}

/**
 * The identifier to send back: only for the same kind and the same text, as they will be sent, after a failed send. An edited
 * message, or another kind, is a new piece and carries none (fw-retry-edit). Never made in the browser.
 */
export function retryId(attempt: Attempt | null, kind: Kind, message: string): string | undefined {
  return attempt && attempt.kind === kind && attempt.message === message.trim()
    ? attempt.submissionId
    : undefined;
}

const SEGMENT_SHAPE =
  /^\/(?:(?:[a-z0-9][a-z0-9-]*|\[[A-Za-z]+\])(?:\/(?:[a-z0-9][a-z0-9-]*|\[[A-Za-z]+\]))*)?$/;

/**
 * FR-AU-68 (a): the route pattern of the page the widget was opened from. Each segment that the router says is the value of a
 * parameter is replaced by its placeholder, so no identifier leaves the application, and the query and the fragment are not
 * part of a pathname. A path that still does not have the contract's shape is sent as the root rather than as itself.
 */
export function routePattern(
  pathname: string,
  params: Record<string, string | string[] | undefined>,
): string {
  const names = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const part of Array.isArray(value) ? value : [value]) names.set(part, name);
  }
  const segments = pathname.split('/').map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // A segment that does not decode is left as it is and fails the shape below.
    }
    const name = names.get(segment) ?? names.get(decoded);
    return name === undefined ? segment : `[${name}]`;
  });
  const pattern = segments.join('/') || '/';
  return pattern.length <= 200 && SEGMENT_SHAPE.test(pattern) ? pattern : '/';
}
