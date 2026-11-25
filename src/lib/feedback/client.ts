// The application's side of the signed wire to the feedback intake of Praktico (FR-AU-75, FR-AU-79;
// docs/contracts/feedback-intake.md, "Application to intake"). PROVISIONAL, with the contract: Praktico owns it.
//
// The signature is the admission channel's, from src/lib/admission/signature.ts: this module makes no second
// implementation of it. The secret is read when a request is signed (`feedbackSecret`), never at load.
// A fault of the configuration throws, and is not a failure to deliver. Nothing here logs: the caller logs the
// outcome, and a message appears in no line.
import { signedHeaders } from '../admission/signature.ts';
import { feedbackSecret } from '../settings.ts';
import type { FeedbackIntake } from '../account/feedback-step.ts';
import type { Kind } from './validate.ts';

/** The host of the intake and the base path of Praktico's tool, both fixed by the contract (fw-intake-path). */
export const INTAKE_ORIGIN = 'https://internal.ekdoti.co';
export const INTAKE_PATH = '/praktico/api/feedback/intake';
export const PSEUDONYMISE_PATH = '/praktico/api/feedback/pseudonymise';
/** FR-AU-77: no answer within 10 seconds is a failure. One attempt of the detach call waits as long. */
export const TIMEOUT_MS = 10_000;

/** The nine fields of the intake's body, and no other (FR-AU-75). */
export interface IntakeBody {
  submissionId: string;
  submittedAt: string;
  kind: Kind;
  message: string;
  route: string;
  appVersion: string;
  browser: { name: string; major: number | null; osFamily: string };
  viewport: { width: number; height: number };
  accountId: string;
}

export interface Dependencies {
  fetch?: typeof fetch;
  now?: () => number;
  secret?: () => string;
}

async function post(
  path: string,
  payload: unknown,
  { fetch: send = fetch, now = Date.now, secret = feedbackSecret } = {},
) {
  const key = secret();
  // The caller signs the bytes it sends; a body written out again would not verify.
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const response = await send(`${INTAKE_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signedHeaders(key, 'POST', path, body, now()) },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // Never follow: a redirect would carry the signed request elsewhere.
    redirect: 'manual',
  });
  let answer: unknown = null;
  try {
    answer = await response.json();
  } catch {
    // Not JSON: the status alone is read below, and it is not acceptance.
  }
  return { status: response.status, answer: answer as Record<string, unknown> | null };
}

/**
 * Delivers one submission. True only for `200` or `201` with `accepted` exactly `true`; a refusal, a body of
 * another shape, a closed connection and no answer within 10 seconds are one failure, false (FR-AU-77).
 * Throws only for the configuration (no usable secret).
 */
export async function deliver(body: IntakeBody, dependencies: Dependencies = {}): Promise<boolean> {
  return (await deliverOutcome(body, dependencies)) !== false;
}

/** What the intake said: `created` for a new submission (201), `held` for a pair it already held (200, fw-wire-align), false for a failure. */
export type Delivery = 'created' | 'held' | false;

/** As `deliver`, saying which acceptance it was. Only `created` is a submission the intake did not hold before (FR-AU-94). */
export async function deliverOutcome(body: IntakeBody, dependencies: Dependencies = {}): Promise<Delivery> {
  // Resolve the secret first so a configuration fault is not taken for a failed send.
  const secret = dependencies.secret ?? feedbackSecret;
  secret();
  try {
    const { status, answer } = await post(INTAKE_PATH, body, dependencies);
    if (answer?.accepted !== true) return false;
    return status === 201 ? 'created' : status === 200 ? 'held' : false;
  } catch {
    return false;
  }
}

/**
 * Step (c) of an account deletion (FR-AU-79): true only for `200` with `accepted` exactly `true` and a whole
 * `changed` (0 included). A failure to reach the intake rejects, and the step is repeated on the timer.
 */
export function feedbackIntake(dependencies: Dependencies = {}): FeedbackIntake {
  return {
    async pseudonymise(accountId) {
      const { status, answer } = await post(PSEUDONYMISE_PATH, { accountId }, dependencies);
      return (
        status === 200 &&
        answer?.accepted === true &&
        Number.isInteger(answer.changed) &&
        (answer.changed as number) >= 0
      );
    },
  };
}
