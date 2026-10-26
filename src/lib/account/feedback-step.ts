// Step (c) of the deletion of an account (FR-AU-58 (c), FR-AU-79; register D112,
// A92, Q26): the feedback intake of Praktico pseudonymises the account's feedback.
//
// THIS IS THE ONE PLACE THAT READS `FEEDBACK_INTAKE_ENABLED`. The working rules
// of the repository (CLAUDE.md, "The Feedback Widget and `FEEDBACK_INTAKE_ENABLED`")
// name this file for it. Nothing else reads the switch, and nothing else may.
//
// The switch is OFF in Ekdotico α 0.1.0. With it off the step makes no call, is
// recorded as skipped (`AccountDeletion.feedbackSkippedAt`), and does not hold the
// deletion back: no Feedback Widget exists, so no feedback has been stored for any
// account. The owner asked for a reminder: WHEN WORK ON THE FEEDBACK WIDGET BEGINS,
// the switch must be turned on in the release that adds it, and the owner told
// before anything else is done (Q26).
//
// What is NOT here, because the Feedback Widget is not in α 0.1.0 (D84; CLAUDE.md:
// "no feedback secret, feedback limit, or call to Praktico"): the client of the
// request. FR-AU-79 and API design ("Feedback intake") give it: a request signed
// with the feedback secret to `/{intake}/api/pseudonymise` with the account's
// identifier, accepted with the number of submissions changed. The release that
// adds the widget replaces `unbuilt` below with that client and adds the setting
// of the secret and the address; the step, its record and its tests need no change.
// Until then a switch turned on does not pretend: the step fails, is repeated,
// and holds the deletion back, as an intake that does not answer would.
import { faultOf } from '../fault.ts';

/**
 * The instruction to the intake of Praktico (FR-AU-79). Resolves to whether it was acknowledged:
 * "the call succeeds where no submission carries the identifier", so an acknowledgement of zero
 * submissions is a true. It rejects, or resolves false, for anything else (no answer within the
 * time the client gives it, a refusal), and the step is then repeated.
 */
export interface FeedbackIntake {
  pseudonymise(accountId: string): Promise<boolean>;
}

// The three ways step (c) fails, each an error of its own: the line of the log names the class of a fault and
// nothing of its message (NFR-SE-19, `faultOf`), so a class is how the reader of the log tells them apart.

/** The switch holds a value that is neither `true` nor `false`: a mistake in the environment. */
export class FeedbackSwitchInvalid extends Error {
  name = 'FeedbackSwitchInvalid';
}
/** The switch is on and the client of the request is not built: it arrives with the Feedback Widget. */
export class FeedbackIntakeUnbuilt extends Error {
  name = 'FeedbackIntakeUnbuilt';
}
/** The intake did not acknowledge: it refused, did not answer, or answered that it had not changed the account's feedback. */
export class FeedbackNotAcknowledged extends Error {
  name = 'FeedbackNotAcknowledged';
}

/** The client the release that adds the Feedback Widget brings. Until then there is none, and a call says so. */
const unbuilt: FeedbackIntake = {
  async pseudonymise() {
    throw new FeedbackIntakeUnbuilt(
      'The feedback intake client is built with the Feedback Widget; FEEDBACK_INTAKE_ENABLED must stay off until then.',
    );
  },
};

/**
 * Whether the switch is on. Off where it is not set, empty, or `false`; on for `true` and for nothing
 * else: a value that is neither is a mistake in the environment, and the step fails on it and says so
 * rather than reading it either way.
 */
export function feedbackIntakeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.FEEDBACK_INTAKE_ENABLED;
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new FeedbackSwitchInvalid('FEEDBACK_INTAKE_ENABLED must be true or false.');
}

export type FeedbackOutcome =
  /** The switch is off: no call was made, and the step is skipped. */
  | 'skipped'
  /** The intake acknowledged the instruction. */
  | 'done';

/**
 * Carries out step (c) for one account: nothing at all with the switch off, and with it on one
 * instruction to the intake. Throws where the instruction was not acknowledged, so that the runner
 * records nothing and repeats the step. The line it logs names the class of the fault and no
 * account (NFR-SE-19).
 */
export async function feedbackStep(
  accountId: string,
  {
    enabled = feedbackIntakeEnabled,
    intake = unbuilt,
  }: { enabled?: () => boolean; intake?: FeedbackIntake } = {},
): Promise<FeedbackOutcome> {
  if (!enabled()) return 'skipped';
  let acknowledged = false;
  try {
    acknowledged = await intake.pseudonymise(accountId);
  } catch (error) {
    if (error instanceof FeedbackIntakeUnbuilt) throw error;
    // The class and the code of the intake's own fault go on as the cause (`faultOf` reads a code there).
    throw new FeedbackNotAcknowledged(`The feedback intake did not acknowledge (${faultOf(error)}).`, {
      cause: error,
    });
  }
  if (!acknowledged) throw new FeedbackNotAcknowledged('The feedback intake did not acknowledge.');
  return 'done';
}
