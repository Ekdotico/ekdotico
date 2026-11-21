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
// With the switch on the step waits 15 seconds and then makes one signed call,
// `pseudonymise`, through the client of src/lib/feedback/client.ts (FR-AU-79;
// docs/contracts/feedback-intake.md, fw-detach-wait). The wait is a delay BEFORE the
// call, longer than the 10 seconds a send may take (FR-AU-77), so that a message sent
// in the same second as the deletion cannot arrive after the detach. It is not a
// timeout on the answer. A call that is not acknowledged, or a secret that is not set
// or not usable, fails the step, which is repeated and holds the deletion back.
import { faultOf } from '../fault.ts';
import { feedbackIntake } from '../feedback/client.ts';

/** fw-detach-wait: the delay before the call. */
export const DETACH_DELAY_MS = 15_000;

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
/** The intake did not acknowledge: it refused, did not answer, or answered in a form that is not an acknowledgement. */
export class FeedbackNotAcknowledged extends Error {
  name = 'FeedbackNotAcknowledged';
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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
    intake = feedbackIntake(),
    wait = sleep,
  }: { enabled?: () => boolean; intake?: FeedbackIntake; wait?: (milliseconds: number) => Promise<void> } = {},
): Promise<FeedbackOutcome> {
  if (!enabled()) return 'skipped';
  // Before the call, and not a timeout on it (fw-detach-wait).
  await wait(DETACH_DELAY_MS);
  let acknowledged = false;
  try {
    acknowledged = await intake.pseudonymise(accountId);
  } catch (error) {
    // The class and the code of the intake's own fault go on as the cause (`faultOf` reads a code there).
    throw new FeedbackNotAcknowledged(`The feedback intake did not acknowledge (${faultOf(error)}).`, {
      cause: error,
    });
  }
  if (!acknowledged) throw new FeedbackNotAcknowledged('The feedback intake did not acknowledge.');
  return 'done';
}
